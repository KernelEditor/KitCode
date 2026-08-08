import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, trustPath, workspaceRootFor } from './paths'

// Serialize complete read-modify-write operations, not only the final rename.
let trustLock: Promise<void> = Promise.resolve()

interface TrustFile {
  version: 1
  workspaces: string[]
}

const emptyTrust = (): TrustFile => ({ version: 1, workspaces: [] })

export async function canonicalWorkspace(cwd: string): Promise<string> {
  const resolved = await workspaceRootFor(cwd)
  return realpath(resolved).catch(() => resolved)
}

export async function isWorkspaceTrusted(cwd: string): Promise<boolean> {
  const workspace = await canonicalWorkspace(cwd)
  const trust = await loadTrust()
  return trust.workspaces.includes(workspace)
}

export async function trustWorkspace(cwd: string): Promise<string> {
  const workspace = await canonicalWorkspace(cwd)
  await withTrustLock(async () => {
    const trust = await readTrust()
    if (!trust.workspaces.includes(workspace)) {
      trust.workspaces.push(workspace)
      trust.workspaces.sort()
      await writeTrust(trust)
    }
  })
  return workspace
}

export async function revokeWorkspaceTrust(cwd: string): Promise<string> {
  const workspace = await canonicalWorkspace(cwd)
  await withTrustLock(async () => {
    const trust = await readTrust()
    const workspaces = trust.workspaces.filter((entry) => entry !== workspace)
    if (workspaces.length !== trust.workspaces.length) await writeTrust({ version: 1, workspaces })
  })
  return workspace
}

async function loadTrust(): Promise<TrustFile> {
  await trustLock
  return readTrust()
}

async function readTrust(): Promise<TrustFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(trustPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyTrust()
    return emptyTrust()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyTrust()
  const value = parsed as { version?: unknown; workspaces?: unknown }
  if (value.version !== 1 || !Array.isArray(value.workspaces)) return emptyTrust()
  return {
    version: 1,
    workspaces: value.workspaces.filter((entry): entry is string => typeof entry === 'string'),
  }
}

async function writeTrust(value: TrustFile): Promise<void> {
  await ensureDir(path.dirname(trustPath))
  const temp = `${trustPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, trustPath)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function withTrustLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = trustLock
  let release!: () => void
  trustLock = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}
