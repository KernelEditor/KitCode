import { spawnSync } from 'node:child_process'

/** Clear both the viewport and saved lines while Ink is suspended. */
export function clearTerminal(stdout: NodeJS.WriteStream): void {
  if (!stdout.isTTY) return
  // Legacy Windows consoles ignore CSI 3 J. Console.Clear clears their whole
  // native screen buffer, including lines above the viewport. A redirected
  // or custom stream must never clear the parent's real terminal.
  const fd = (stdout as NodeJS.WriteStream & { fd?: number }).fd
  if (process.platform === 'win32' && fd !== undefined && Number.isInteger(fd)) {
    try {
      spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Clear()'], {
        stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 2000,
      })
    } catch { /* ANSI remains available if the native console cannot be used. */ }
  }
  stdout.write('\x1b[2J\x1b[3J\x1b[H')
}
