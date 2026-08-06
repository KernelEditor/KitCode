import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { checkpointsDir, ensureDir } from '../config/paths'
import { resolveInside } from '../tools/safepath'

const VERSION = 1
const MAX_FILE_BYTES = 5_000_000
const MAX_CHECKPOINT_BYTES = 20_000_000
const MAX_CHECKPOINT_JSON_BYTES = 30_000_000
const MAX_CHECKPOINTS_PER_SESSION = 20
const MAX_ENTRIES = 256
const CHECKPOINT_NAME = /^\d{13}-[a-f0-9]{8}\.json$/
let lastCheckpointTimestamp = 0

interface FileSnapshot {
  existed: boolean
  data?: string
  mode?: number
}

interface Fingerprint {
  existed: boolean
  sha256?: string
}

interface CheckpointEntry {
  path: string
  before: FileSnapshot
  after: Fingerprint
}

interface StoredCheckpoint {
  version: typeof VERSION
  sessionId: string
  cwd: string
  createdAt: string
  entries: CheckpointEntry[]
}

interface CapturedEntry {
  path: string
  absolutePath: string
  before: FileSnapshot
}

export interface CheckpointCommit {
  id: string
  paths: string[]
}

export interface UndoFailure {
  path: string
  error: string
}

export interface UndoResult {
  found: boolean
  restored: string[]
  removed: string[]
  conflicts: string[]
  failed: UndoFailure[]
}

export interface FileCheckpoint {
  
  capture(absolutePath: string): Promise<void>
  
  markChanged(absolutePath: string): void
  
  changedPaths(): string[]
  
  commit(): Promise<CheckpointCommit | null>
}

export function beginCheckpoint(options: {
  cwd: string
  sessionId: string
  storageDir?: string
}): FileCheckpoint {
  assertSessionId(options.sessionId)
  const root = workspaceRoot(options.cwd)
  const storageDir = options.storageDir ?? checkpointsDir
  const captured = new Map<string, CapturedEntry>()
  const pending = new Map<string, Promise<void>>()
  const changed = new Set<string>()
  let capturedBytes = 0
  let finished = false

  const locate = (file: string) => {
    const safe = resolveInside(root, file)
    if (!safe.ok || safe.relative === '') {
      throw new Error(safe.ok ? 'The workspace root cannot be checkpointed as a file.' : safe.reason)
    }
    return safe
  }

  return {
    async capture(absolutePath) {
      if (finished) throw new Error('This checkpoint is already closed.')
      const safe = locate(absolutePath)
      if (captured.has(safe.relative)) return
      const active = pending.get(safe.relative)
      if (active) return active
      if (captured.size + pending.size >= MAX_ENTRIES) {
        throw new Error(`Automatic undo is limited to ${MAX_ENTRIES} files per message.`)
      }

      const task = (async () => {
        const { snapshot, bytes } = await snapshotFile(safe.path)
        if (capturedBytes + bytes > MAX_CHECKPOINT_BYTES) {
          throw new Error(
            `Automatic undo is limited to ${MAX_CHECKPOINT_BYTES / 1_000_000} MB of original files per message.`,
          )
        }
        capturedBytes += bytes
        captured.set(safe.relative, {
          path: safe.relative,
          absolutePath: safe.path,
          before: snapshot,
        })
      })()
      pending.set(safe.relative, task)
      try {
        await task
      } finally {
        pending.delete(safe.relative)
      }
    },

    markChanged(absolutePath) {
      if (finished) return
      const resolved = path.resolve(absolutePath)
      let capturedEntry = [...captured.values()].find((entry) => entry.absolutePath === resolved)
      if (!capturedEntry) {
        const safe = resolveInside(root, absolutePath)
        if (safe.ok) capturedEntry = captured.get(safe.relative)
      }
      if (capturedEntry) changed.add(capturedEntry.path)
    },

    changedPaths() {
      return [...changed].sort()
    },

    async commit() {
      if (finished) return null
      finished = true
      await Promise.all(pending.values())

      const entries: CheckpointEntry[] = []
      for (const relativePath of [...changed].sort()) {
        const entry = captured.get(relativePath)
        if (!entry) continue
        const after = await fingerprint(entry.absolutePath)
        if (matchesSnapshot(entry.before, after)) continue
        entries.push({ path: entry.path, before: entry.before, after })
      }
      if (entries.length === 0) return null

      const stored: StoredCheckpoint = {
        version: VERSION,
        sessionId: options.sessionId,
        cwd: root,
        createdAt: new Date().toISOString(),
        entries,
      }
      const sessionDir = path.join(storageDir, options.sessionId)
      await ensureDir(storageDir)
      await ensureDir(sessionDir)
      lastCheckpointTimestamp = Math.max(Date.now(), lastCheckpointTimestamp + 1)
      const id = `${String(lastCheckpointTimestamp).padStart(13, '0')}-${randomBytes(4).toString('hex')}`
      await writeCheckpoint(path.join(sessionDir, `${id}.json`), stored)
      await pruneCheckpoints(sessionDir)
      return { id, paths: entries.map((entry) => entry.path) }
    },
  }
}

export async function undoLatestCheckpoint(options: {
  cwd: string
  sessionId: string
  storageDir?: string
}): Promise<UndoResult> {
  assertSessionId(options.sessionId)
  const root = workspaceRoot(options.cwd)
  const sessionDir = path.join(options.storageDir ?? checkpointsDir, options.sessionId)
  const file = await newestCheckpoint(sessionDir)
  const empty: UndoResult = { found: false, restored: [], removed: [], conflicts: [], failed: [] }
  if (!file) return empty

  const checkpoint = await readCheckpoint(file)
  if (checkpoint.sessionId !== options.sessionId || checkpoint.cwd !== root) {
    throw new Error('The latest undo checkpoint belongs to a different workspace or session.')
  }

  const result: UndoResult = { ...empty, found: true }
  const retry: CheckpointEntry[] = []
  for (const entry of checkpoint.entries) {
    const safe = resolveInside(root, entry.path)
    if (!safe.ok || safe.relative !== entry.path) {
      result.conflicts.push(entry.path)
      continue
    }

    try {
      const current = await fingerprint(safe.path)
      if (!sameFingerprint(current, entry.after)) {
        result.conflicts.push(entry.path)
        continue
      }
      if (entry.before.existed) {
        await restoreFile(root, entry.path, entry.before, entry.after)
        result.restored.push(entry.path)
      } else {
        await unlink(safe.path)
        result.removed.push(entry.path)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ path: entry.path, error: message })
      retry.push(entry)
    }
  }

  if (retry.length === 0) {
    await unlink(file)
  } else {
    await writeCheckpoint(file, { ...checkpoint, entries: retry })
  }
  return result
}

async function snapshotFile(file: string): Promise<{ snapshot: FileSnapshot; bytes: number }> {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { snapshot: { existed: false }, bytes: 0 }
    }
    throw error
  }
  if (!info.isFile()) throw new Error(`Cannot checkpoint a non-file path: ${file}`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`Cannot checkpoint ${file}: it exceeds the ${MAX_FILE_BYTES / 1_000_000} MB limit.`)
  }
  const data = await readFile(file)
  if (data.length > MAX_FILE_BYTES) {
    throw new Error(`Cannot checkpoint ${file}: it changed beyond the file-size limit while reading.`)
  }
  return {
    snapshot: { existed: true, data: data.toString('base64'), mode: info.mode & 0o777 },
    bytes: data.length,
  }
}

async function fingerprint(file: string): Promise<Fingerprint> {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false }
    throw error
  }
  const hash = createHash('sha256')
  if (!info.isFile()) {
    hash.update(`kitcode:${info.isDirectory() ? 'directory' : 'non-file'}`)
    return { existed: true, sha256: hash.digest('hex') }
  }
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return { existed: true, sha256: hash.digest('hex') }
}

function matchesSnapshot(before: FileSnapshot, after: Fingerprint): boolean {
  if (before.existed !== after.existed) return false
  if (!before.existed) return true
  const data = Buffer.from(before.data ?? '', 'base64')
  return after.sha256 === createHash('sha256').update(data).digest('hex')
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.existed === b.existed && (!a.existed || a.sha256 === b.sha256)
}

async function restoreFile(
  root: string,
  relativePath: string,
  snapshot: FileSnapshot,
  expected: Fingerprint,
): Promise<void> {
  const safe = resolveInside(root, relativePath)
  if (!safe.ok || safe.relative !== relativePath) throw new Error('The restore path changed.')
  const data = decodeSnapshot(snapshot)
  await mkdir(path.dirname(safe.path), { recursive: true })
  const rechecked = resolveInside(root, relativePath)
  if (!rechecked.ok || rechecked.path !== safe.path || rechecked.relative !== relativePath) {
    throw new Error('The restore path changed while preparing its parent directory.')
  }
  const temp = `${rechecked.path}.${process.pid}.${randomBytes(4).toString('hex')}.undo`
  try {
    await writeFile(temp, data, { mode: snapshot.mode ?? 0o600 })
    await chmod(temp, snapshot.mode ?? 0o600)
    const finalPath = resolveInside(root, relativePath)
    if (!finalPath.ok || finalPath.path !== rechecked.path || finalPath.relative !== relativePath) {
      throw new Error('The restore path changed before the file could be replaced.')
    }
    if (!sameFingerprint(await fingerprint(finalPath.path), expected)) {
      throw new Error('The file changed while the checkpoint was being restored.')
    }
    await rename(temp, rechecked.path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function writeCheckpoint(file: string, checkpoint: StoredCheckpoint): Promise<void> {
  const body = `${JSON.stringify(checkpoint)}\n`
  if (Buffer.byteLength(body) > MAX_CHECKPOINT_JSON_BYTES) {
    throw new Error('Undo checkpoint exceeds its storage limit.')
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function readCheckpoint(file: string): Promise<StoredCheckpoint> {
  const info = await stat(file)
  if (info.size > MAX_CHECKPOINT_JSON_BYTES) throw new Error('Undo checkpoint is too large to read.')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Undo checkpoint is not valid JSON: ${(error as Error).message}`)
  }
  if (!isCheckpoint(parsed)) throw new Error('Undo checkpoint has an invalid format.')
  return parsed
}

function isCheckpoint(value: unknown): value is StoredCheckpoint {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<StoredCheckpoint>
  if (
    item.version !== VERSION ||
    typeof item.sessionId !== 'string' ||
    typeof item.cwd !== 'string' ||
    typeof item.createdAt !== 'string' ||
    !Array.isArray(item.entries) ||
    item.entries.length === 0 ||
    item.entries.length > MAX_ENTRIES
  ) {
    return false
  }
  return item.entries.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const candidate = entry as Partial<CheckpointEntry>
    if (
      typeof candidate.path !== 'string' ||
      candidate.path === '' ||
      path.isAbsolute(candidate.path) ||
      typeof candidate.before !== 'object' ||
      candidate.before === null ||
      typeof candidate.after !== 'object' ||
      candidate.after === null ||
      typeof candidate.before.existed !== 'boolean' ||
      typeof candidate.after.existed !== 'boolean'
    ) {
      return false
    }
    if (candidate.before.existed) {
      if (
        typeof candidate.before.data !== 'string' ||
        typeof candidate.before.mode !== 'number' ||
        !Number.isInteger(candidate.before.mode) ||
        candidate.before.mode < 0 ||
        candidate.before.mode > 0o777 ||
        !validBase64(candidate.before.data)
      ) {
        return false
      }
      if (Buffer.byteLength(candidate.before.data, 'base64') > MAX_FILE_BYTES) return false
    }
    return (
      !candidate.after.existed ||
      (typeof candidate.after.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.after.sha256))
    )
  })
}

function decodeSnapshot(snapshot: FileSnapshot): Buffer {
  if (!snapshot.existed || typeof snapshot.data !== 'string' || !validBase64(snapshot.data)) {
    throw new Error('Checkpoint does not contain restorable file data.')
  }
  const data = Buffer.from(snapshot.data, 'base64')
  if (data.length > MAX_FILE_BYTES) throw new Error('Checkpoint file data exceeds the restore limit.')
  return data
}

function validBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
}

async function newestCheckpoint(sessionDir: string): Promise<string | null> {
  let names: string[]
  try {
    names = await readdir(sessionDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const name = names.filter((candidate) => CHECKPOINT_NAME.test(candidate)).sort().at(-1)
  return name ? path.join(sessionDir, name) : null
}

async function pruneCheckpoints(sessionDir: string): Promise<void> {
  const names = (await readdir(sessionDir))
    .filter((candidate) => CHECKPOINT_NAME.test(candidate))
    .sort()
    .reverse()
  await Promise.all(
    names.slice(MAX_CHECKPOINTS_PER_SESSION).map((name) => unlink(path.join(sessionDir, name))),
  )
}

function workspaceRoot(cwd: string): string {
  const safe = resolveInside(cwd, '.')
  if (!safe.ok) throw new Error(safe.reason)
  return safe.path
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,240}$/.test(id)) {
    throw new Error(`Invalid session id: ${id}`)
  }
}
