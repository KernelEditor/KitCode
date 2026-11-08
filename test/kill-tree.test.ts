import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { killTree } from '../src/tools/kill-tree'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const platform = process.platform
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); vi.mocked(spawn).mockReset() })

it.each(['error', 'close'] as const)('falls back safely when taskkill emits %s', (event) => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const killer = new EventEmitter()
  vi.mocked(spawn).mockReturnValue(killer as ChildProcess)
  const kill = vi.fn()
  killTree({ pid: 123, kill } as unknown as ChildProcess)
  expect(() => killer.emit(event, event === 'error' ? new Error('ENOENT') : 1)).not.toThrow()
  expect(kill).toHaveBeenCalledWith('SIGKILL')
  expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '123', '/t', '/f'], { stdio: 'ignore', windowsHide: true })
})

it('falls back when the process group has already disappeared', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
  const kill = vi.fn(() => { throw new Error('ESRCH') })
  expect(() => killTree({ pid: 123, kill } as unknown as ChildProcess)).not.toThrow()
  expect(kill).toHaveBeenCalledWith('SIGKILL')
})
