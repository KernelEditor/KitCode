import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import OpenAI from 'openai'
import { afterEach, describe, expect, it } from 'vitest'
import { DETECT_TIMEOUT_MS, detectProvider } from '../src/config/detect'
import { createAnthropicProvider } from '../src/providers/anthropic'
import { describeProviderFailure, isRetryableFailure, MAX_RETRIES } from '../src/providers/errors'
import { createOpenAiProvider } from '../src/providers/openai-compat'
import { ProviderError } from '../src/providers/types'
import type { ChatRequest, StreamEvent } from '../src/providers/types'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

const servers: http.Server[] = []
const sockets = new Set<Socket>()

async function startServer(handler: Handler): Promise<string> {
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closedPortUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return url
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

function chatRequest(signal?: AbortSignal): ChatRequest {
  return {
    model: 'test-model',
    system: 'be brief',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 64,
    signal,
  }
}

function sseChunk(delta: object, finishReason: string | null): string {
  const body = {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  return `data: ${JSON.stringify(body)}\n\n`
}

function anthropicPrefix(): string[] {
  const message = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 1 },
  }
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`,
  ]
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
}

describe('transient provider faults', () => {
  it('forwards provider rate-limit headers with a successful streamed response', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '87',
        'x-ratelimit-reset-requests': '2s',
      })
      res.write(sseChunk({ role: 'assistant', content: 'ok' }, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
    const provider = createOpenAiProvider({
      id: 'limited',
      apiKey: 'sk-test',
      baseUrl: `${baseUrl}/v1`,
    })

    const events = await collect(provider.stream(chatRequest()))

    expect(events).toContainEqual({
      type: 'rate_limits',
      limits: { requests: { limit: 100, remaining: 87, reset: '2s' } },
    })
    expect(events.some((event) => event.type === 'usage')).toBe(false)
  })

  it('retries a 503 and hands the caller a normal streamed result', async () => {
    const seen: string[] = []
    const baseUrl = await startServer((req, res) => {
      seen.push(req.url ?? '')
      if (seen.length === 1) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseChunk({ role: 'assistant', content: 'hello ' }, null))
      res.write(sseChunk({ content: 'world' }, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })

    const provider = createOpenAiProvider({
      id: 'flaky',
      apiKey: 'sk-test',
      baseUrl: `${baseUrl}/v1`,
    })
    const events = await collect(provider.stream(chatRequest()))
    const done = events.at(-1)

    expect(seen).toHaveLength(2)
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual([
      'hello ',
      'world',
    ])
    expect(done).toMatchObject({ type: 'done', stopReason: 'end_turn' })
  })

  it('gives a permanently overloaded provider four attempts, then reports it plainly', async () => {
    let requests = 0
    const baseUrl = await startServer((_req, res) => {
      requests += 1
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no capacity' } }))
    })

    const provider = createAnthropicProvider({ id: 'anthropic', apiKey: 'sk-test', baseUrl })
    const error = (await failure(provider.listModels())) as ProviderError

    expect(requests).toBe(1 + MAX_RETRIES)
    expect(error.status).toBe(503)
    expect(error.message).toContain('"anthropic" is down or overloaded (503)')
    expect(error.message).toContain('try again shortly')
  }, 20_000)

  it('never retries a 401 and explains it in one human line', async () => {
    let requests = 0
    const baseUrl = await startServer((_req, res) => {
      requests += 1
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    })

    const provider = createOpenAiProvider({
      id: 'acme',
      apiKey: 'sk-super-secret-key-value',
      baseUrl: `${baseUrl}/v1`,
    })
    const error = (await failure(provider.listModels())) as ProviderError

    expect(requests).toBe(1)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.status).toBe(401)
    expect(error.message).toContain('The API key for "acme" was rejected (401)')
    expect(error.message).toContain('kitcode add')
    expect(error.message).not.toContain('sk-super-secret-key-value')
    expect(error.message).not.toContain('\n')
    expect(isRetryableFailure(error)).toBe(false)
  })
})

describe('cancellation and timeout stay distinct', () => {
  async function openStream(): Promise<{ url: string; count: () => number }> {
    let requests = 0
    const url = await startServer((_req, res) => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseChunk({ role: 'assistant', content: 'partial' }, null))
    })
    return { url, count: () => requests }
  }

  it('treats a user cancellation as a normal aborted turn, with no retry', async () => {
    const { url, count } = await openStream()
    const provider = createOpenAiProvider({ id: 'acme', apiKey: 'sk-test', baseUrl: `${url}/v1` })
    const canceller = new AbortController()

    const events: StreamEvent[] = []
    for await (const event of provider.stream(chatRequest(canceller.signal))) {
      events.push(event)
      if (event.type === 'text_delta') canceller.abort()
    }

    expect(count()).toBe(1)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stopReason: 'aborted',
      content: [{ type: 'text', text: 'partial' }],
    })
  }, 15_000)

  it('cancels an anthropic turn without losing the partial answer', async () => {
    let requests = 0
    const url = await startServer((_req, res) => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of anthropicPrefix()) res.write(event)
    })
    const provider = createAnthropicProvider({ id: 'anthropic', apiKey: 'sk-test', baseUrl: url })
    const canceller = new AbortController()

    const events: StreamEvent[] = []
    for await (const event of provider.stream(chatRequest(canceller.signal))) {
      events.push(event)
      if (event.type === 'text_delta') canceller.abort()
    }

    expect(requests).toBe(1)
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      stopReason: 'aborted',
      content: [{ type: 'text', text: 'partial' }],
    })
  }, 15_000)

  it('reports a stalled provider as an error instead of a silent cancellation', async () => {
    let requests = 0
    const url = await startServer(() => {
      requests += 1
    })
    const provider = createOpenAiProvider({
      id: 'acme',
      apiKey: 'sk-test',
      baseUrl: `${url}/v1`,
      timeoutMs: 150,
    })

    const error = (await failure(collect(provider.stream(chatRequest())))) as ProviderError

    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toMatch(/ran out of time/)
    expect(error.message).not.toMatch(/cancelled/i)
    expect(requests).toBe(1 + MAX_RETRIES)
  }, 20_000)
})

describe('detectProvider timeouts', () => {
  it('defaults to a 15 second probe budget', () => {
    expect(DETECT_TIMEOUT_MS).toBe(15_000)
  })

  it('gives up on a silent host and still tries the remaining candidate', async () => {
    let requests = 0
    const baseUrl = await startServer(() => {
      requests += 1
    })

    const error = (await failure(detectProvider(baseUrl, 'sk-test', { timeoutMs: 300 }))) as Error

    expect(error.message).toMatch(/timed out after 0\.3s/)
    expect(error.message).toContain('/v1/models')
    expect(requests).toBe(2)
  }, 5_000)

  it('keeps a key echoed by the probed host out of the onboarding error', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid key sk-live-abcdef123456' }))
    })

    const error = (await failure(detectProvider(baseUrl, 'sk-live-abcdef123456'))) as Error

    expect(error.message).not.toContain('sk-live-abcdef123456')
    expect(error.message).toContain('[redacted]')
  }, 10_000)

  it('bounds an injected fetch that ignores the abort signal', async () => {
    const started = Date.now()
    const error = (await failure(
      detectProvider('https://example.invalid', 'sk-test', {
        timeoutMs: 200,
        fetchImpl: () => new Promise<Response>(() => {}),
      }),
    )) as Error

    expect(error.message).toMatch(/timed out after 0\.2s/)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 5_000)
})

describe('describeProviderFailure', () => {
  it('digs a refused connection out of undici "fetch failed"', async () => {
    const url = await closedPortUrl()
    const error = await failure(fetch(`${url}/v1/models`))

    const message = describeProviderFailure(error, 'local')

    expect((error as Error).message).toBe('fetch failed')
    expect(message).toContain('Cannot reach "local"')
    expect(message).toContain('ECONNREFUSED')
    expect(message).not.toContain('\n')
    expect(isRetryableFailure(error)).toBe(true)
  })

  it('separates a user cancellation from a timeout', () => {
    expect(describeProviderFailure(new OpenAI.APIUserAbortError(), 'acme')).toMatch(/cancelled/i)
    expect(isRetryableFailure(new OpenAI.APIUserAbortError())).toBe(false)

    const timeout = new OpenAI.APIConnectionTimeoutError()
    expect(describeProviderFailure(timeout, 'acme')).toMatch(/ran out of time/i)
    expect(isRetryableFailure(timeout)).toBe(true)
  })

  it('surfaces retry-after seconds on a rate limit', () => {
    const limited = new OpenAI.RateLimitError(
      429,
      { error: { message: 'slow down' } },
      undefined,
      new Headers({ 'retry-after': '12' }),
    )

    expect(describeProviderFailure(limited, 'acme')).toBe(
      '"acme" rate limited this request (429) — retry after 12s',
    )
  })

  it('redacts a key echoed back by the provider without eating the model id', () => {
    const denied = new OpenAI.PermissionDeniedError(
      403,
      { error: { message: 'key sk-abc123DEF456 cannot use claude-sonnet-4-5-20250929' } },
      undefined,
      new Headers(),
    )

    const message = describeProviderFailure(denied, 'acme')

    expect(message).not.toContain('sk-abc123DEF456')
    expect(message).toContain('[redacted]')
    expect(message).toContain('claude-sonnet-4-5-20250929')
  })

  it('keeps a 5xx body out of the line and 4xx bodies readable', () => {
    const gateway = new OpenAI.InternalServerError(
      502,
      undefined,
      '<html>\n<head>bad gateway</head>\n</html>',
      new Headers(),
    )
    expect(describeProviderFailure(gateway, 'acme')).toBe(
      '"acme" is down or overloaded (502) — try again shortly',
    )

    const missing = new OpenAI.NotFoundError(
      404,
      { error: { message: 'model gpt-9 does not exist' } },
      undefined,
      new Headers(),
    )
    expect(describeProviderFailure(missing, 'acme')).toBe(
      '"acme" has no such model, or the base URL is wrong (404) — model gpt-9 does not exist',
    )
  })
})
