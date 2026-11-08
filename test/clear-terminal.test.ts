import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { clearTerminal } from '../src/ui/clear-terminal'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.mocked(spawnSync).mockReset()
})

it('clears the Windows native buffer before ANSI scrollback', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const write = vi.fn()
  clearTerminal({ isTTY: true, fd: 1, write } as unknown as NodeJS.WriteStream)
  expect(spawnSync).toHaveBeenCalledWith('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Clear()'], {
    stdio: ['ignore', 1, 'ignore'], windowsHide: true, timeout: 2000,
  })
  expect(write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H')
  expect(vi.mocked(spawnSync).mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!)
})

it('falls back to ANSI if the Windows native clear fails', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(spawnSync).mockImplementation(() => { throw new Error('not available') })
  const write = vi.fn()
  expect(() => clearTerminal({ isTTY: true, fd: 1, write } as unknown as NodeJS.WriteStream)).not.toThrow()
  expect(write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H')
})

it('does not touch the real terminal for a custom or redirected stream', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const write = vi.fn()
  clearTerminal({ isTTY: true, write } as unknown as NodeJS.WriteStream)
  expect(spawnSync).not.toHaveBeenCalled()
  write.mockClear()
  clearTerminal({ isTTY: false, fd: 1, write } as unknown as NodeJS.WriteStream)
  expect(spawnSync).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
})
