import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, lstat, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface DirectoryIdentity {
  dev: number
  ino: number
}

export type SafeFileSnapshot =
  | { exists: false; data: null; mode: number; parent: DirectoryIdentity }
  | {
      exists: true
      data: Buffer
      mode: number
      identity: FileIdentity
      parent: DirectoryIdentity
    }

export class UnsafeFileChangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFileChangeError'
  }
}

export async function readSafeFileSnapshot(
  file: string,
  maxBytes: number,
): Promise<SafeFileSnapshot> {
  const parent = await lstat(dirname(file))
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new UnsafeFileChangeError('the parent path is not a real directory')
  }
  const parentIdentity = directoryIdentity(parent)
  const pathInfo = await lstatMaybe(file)
  if (!pathInfo) return { exists: false, data: null, mode: 0o666, parent: parentIdentity }
  if (pathInfo.isSymbolicLink()) {
    throw new UnsafeFileChangeError('the path is a symbolic link')
  }
  if (!pathInfo.isFile()) throw new UnsafeFileChangeError('the path is not a regular file')
  if (pathInfo.size > maxBytes) throw new UnsafeFileChangeError('the file is too large')

  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameObject(pathInfo, opened)) {
      throw new UnsafeFileChangeError('the file changed while it was being opened')
    }
    const data = await readBounded(handle, maxBytes)
    const afterRead = await handle.stat()
    if (!sameVersion(opened, afterRead)) {
      throw new UnsafeFileChangeError('the file changed while it was being read')
    }
    return {
      exists: true,
      data,
      mode: opened.mode & 0o777,
      identity: fileIdentity(opened),
      parent: parentIdentity,
    }
  } finally {
    await handle.close()
  }
}

export async function atomicWriteSafeFile(
  file: string,
  data: string | Buffer,
  snapshot: SafeFileSnapshot,
): Promise<void> {
  const parent = dirname(file)
  await assertSameParent(parent, snapshot.parent)
  const temp = join(parent, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temp, 'wx', snapshot.mode)
    await handle.writeFile(data, typeof data === 'string' ? { encoding: 'utf8' } : undefined)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temp, snapshot.mode)

    await assertSameParent(parent, snapshot.parent)
    const current = await lstatMaybe(file)
    if (!matchesSnapshot(current, snapshot)) {
      throw new UnsafeFileChangeError('the destination changed before it could be replaced')
    }

    // rename replaces the directory entry itself; a symlink that appears at
    // the destination is never opened or followed.
    await rename(temp, file)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const remaining = maxBytes + 1 - total
    if (remaining <= 0) throw new UnsafeFileChangeError('the file is too large')
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) return Buffer.concat(chunks, total)
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
  }
}

async function assertSameParent(parent: string, expected: DirectoryIdentity): Promise<void> {
  const current = await lstat(parent)
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new UnsafeFileChangeError('the parent directory changed during the write')
  }
}

function matchesSnapshot(current: Stats | null, snapshot: SafeFileSnapshot): boolean {
  if (!snapshot.exists) return current === null
  return Boolean(
    current &&
      !current.isSymbolicLink() &&
      current.isFile() &&
      sameIdentity(current, snapshot.identity),
  )
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameVersion(left: Stats, right: Stats): boolean {
  return (
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameIdentity(info: Stats, identity: FileIdentity): boolean {
  return (
    info.dev === identity.dev &&
    info.ino === identity.ino &&
    info.size === identity.size &&
    info.mtimeMs === identity.mtimeMs &&
    info.ctimeMs === identity.ctimeMs
  )
}

function fileIdentity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

function directoryIdentity(info: Stats): DirectoryIdentity {
  return { dev: info.dev, ino: info.ino }
}

async function lstatMaybe(file: string): Promise<Stats | null> {
  try {
    return await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
