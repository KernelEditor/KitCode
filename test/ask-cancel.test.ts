import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ boot: vi.fn(), create: vi.fn() }))
vi.mock('../src/app/runtime', () => ({ boot: mocks.boot }))
vi.mock('node:readline/promises', () => ({ createInterface: mocks.create }))
import { ask } from '../src/app/ask'
it('cancels a pending permission question on readline Ctrl+C', async () => {
  const rl = new EventEmitter() as EventEmitter & { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  rl.close = vi.fn()
  rl.question = vi.fn((_text, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
    queueMicrotask(() => rl.emit('SIGINT'))
  }))
  mocks.create.mockReturnValue(rl)
  const shutdown = vi.fn()
  const persist = vi.fn()
  mocks.boot.mockResolvedValue({ history: [], warnings: [], shutdown, runtime: {
    startupUpdateCheck: async () => ({ status: 'current' }), persist, usageLine: () => '',
    run: async (history: unknown, hooks: any, signal: AbortSignal) => {
      expect(await hooks.requestPermission({ summary: 'test', input: {} })).toBe('deny')
      expect(signal.aborted).toBe(true)
      return history
    },
  } })
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await ask('test')
    expect(rl.close).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledTimes(2)
  } finally {
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty)
    else Reflect.deleteProperty(process.stdin, 'isTTY')
    out.mockRestore()
    err.mockRestore()
  }
})
