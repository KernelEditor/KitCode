import { afterEach, expect, it, vi } from 'vitest'
import { streamWithRetry } from '../src/core/retry'
import { ProviderError } from '../src/providers/types'
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types'

const request: ChatRequest = { model: 'test', system: '', messages: [], tools: [], maxTokens: 100 }
const done: StreamEvent = { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }
const limited = () => new ProviderError('limited', 'test', 429, { cause: { headers: new Headers({ 'retry-after-ms': '1' }) } })
function provider(stream: Provider['stream']): Provider {
  return { id: 'test', kind: 'openai', stream, knownModels: () => [], listModels: async () => [] }
}
async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
afterEach(() => vi.restoreAllMocks())

it('passes cancellation to the provider even when the request has no signal', async () => {
  const controller = new AbortController()
  let received: AbortSignal | undefined
  const p = provider(async function* (req) { received = req.signal; yield done })
  await collect(streamWithRetry(p, request, controller.signal))
  expect(received).toBe(controller.signal)
})

it.each(['text_delta', 'thinking_delta'] as const)('does not replay a request after emitting %s', async (type) => {
  let calls = 0
  const p = provider(async function* () {
    calls++
    if (calls === 1) { yield { type, text: 'partial' }; throw limited() }
    yield done
  })
  await expect(collect(streamWithRetry(p, request, new AbortController().signal))).rejects.toThrow('limited')
  expect(calls).toBe(1)
})

it('does not turn provider cancellation into an error', async () => {
  const controller = new AbortController()
  const p = provider(async function* () { controller.abort(); throw new Error('cancelled network') })
  await expect(collect(streamWithRetry(p, request, controller.signal))).resolves.toEqual([])
})

it('honors an HTTP date in Retry-After', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-08T10:00:00Z'))
  const p = provider(async function* () {
    throw new ProviderError('limited', 'test', 429, { cause: { headers: new Headers({ 'retry-after': 'Sun, 08 Nov 2026 10:00:12 GMT' }) } })
  })
  const stream = streamWithRetry(p, request, new AbortController().signal)
  expect((await stream.next()).value).toMatchObject({ type: 'retrying', waitMs: 12_000 })
  await stream.return(undefined)
})
