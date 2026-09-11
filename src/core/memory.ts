import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, homeDir } from '../config/paths'
import { redactSecrets } from '../providers/errors'

export function projectMemoryPath(workspace: string): string {
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  return path.join(homeDir, 'memory', createHash('sha256').update(key).digest('hex') + '.txt')
}

export async function readProjectMemory(workspace: string): Promise<string> {
  try {
    return await readFile(projectMemoryPath(workspace), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function saveProjectMemory(workspace: string, text: string): Promise<void> {
  if (text.length > 16_000) throw new Error('Project memory is limited to 16,000 characters.')
  const file = projectMemoryPath(workspace)
  await ensureDir(path.dirname(file))
  await writeFile(file, redactSecrets(text), { mode: 0o600 })
}

export async function clearProjectMemory(workspace: string): Promise<void> {
  await rm(projectMemoryPath(workspace), { force: true })
}
