import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, trustPath, workspaceRootFor } from './paths'

// Simple mutex to prevent concurrent trust file modifications
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
  const trust = await loadTrust()
  if (!trust.workspaces.includes(workspace)) {
    trust.workspaces.push(workspace)
    trust.workspaces.sort()
    await saveTrust(trust)
  }
  return workspace
}

export async function revokeWorkspaceTrust(cwd: string): Promise<string> {
  const workspace = await canonicalWorkspace(cwd)
  const trust = await loadTrust()
  const workspaces = trust.workspaces.filter((entry) => entry !== workspace)
  if (workspaces.length !== trust.workspaces.length) await saveTrust({ version: 1, workspaces })
  return workspace
}

async function loadTrust(): Promise<TrustFile> {
  await trustLock
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

async function saveTrust(value: TrustFile): Promise<void> {
  // Wait for any pending read to complete, then acquire lock
  const release = trustLock
  let resolveLock: () => void
  trustLock = new Promise<void>((resolve) => { resolveLock = resolve })
  await release
  try {
    await ensureDir(path.dirname(trustPath))
    const temp = `${trustPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, trustPath)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  } finally {
    resolveLock!()
  }
}
