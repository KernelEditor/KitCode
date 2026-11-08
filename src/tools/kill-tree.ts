import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export function killTree(child: ChildProcess): void {
  if (child.pid == null) return
  const fallback = () => {
    try { child.kill('SIGKILL') } catch { /* The process may already be gone. */ }
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore', windowsHide: true,
      })
      // Spawn failures arrive asynchronously; try/catch alone misses ENOENT.
      killer.once('error', fallback)
      killer.once('close', (code) => { if (code !== 0) fallback() })
    } catch { fallback() }
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { fallback() }
}
