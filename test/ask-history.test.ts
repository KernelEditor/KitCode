import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentHooks } from '../src/core/types'
import type { Message } from '../src/providers/types'

const mocks = vi.hoisted(() => ({ boot: vi.fn() }))
vi.mock('../src/app/runtime', () => ({ boot: mocks.boot }))
import { ask } from '../src/app/ask'

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

it('saves the user request before contacting a provider that fails', async () => {
  const persist = vi.fn()
  const shutdown = vi.fn()
  mocks.boot.mockResolvedValue({ history: [], warnings: [], shutdown, runtime: {
    startupUpdateCheck: async () => ({ status: 'current' }), persist,
    run: async () => {
      expect(persist).toHaveBeenCalledWith([{ role: 'user', content: [{ type: 'text', text: 'keep this request' }] }])
      throw new Error('provider unavailable')
    },
  } })
  await expect(ask('keep this request')).rejects.toThrow('provider unavailable')
  expect(shutdown).toHaveBeenCalledOnce()
})

it('saves completed tool work when a later provider request fails', async () => {
  const persist = vi.fn()
  const shutdown = vi.fn()
  const latest: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'work' }] },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'read', id: 't1', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'completed work' }] },
  ]
  mocks.boot.mockResolvedValue({ history: [], warnings: [], shutdown, runtime: {
    startupUpdateCheck: async () => ({ status: 'current' }), persist,
    run: async (_history: Message[], hooks: AgentHooks) => {
      hooks.onHistory?.(latest)
      throw new Error('connection lost')
    },
  } })
  await expect(ask('work')).rejects.toThrow('connection lost')
  expect(persist).toHaveBeenLastCalledWith(latest)
  expect(shutdown).toHaveBeenCalledOnce()
})
