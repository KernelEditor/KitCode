import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProvider } from '../src/config/detect'
import { MAX_TOOL_CALLS_PER_STEP, runTurn } from '../src/core/agent'
import type { AgentConfig } from '../src/core/agent'
import type { AgentEvent, AgentHooks } from '../src/core/types'
import { createAnthropicProvider } from '../src/providers/anthropic'
import { createOpenAiProvider } from '../src/providers/openai-compat'
import { ProviderError } from '../src/providers/types'
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types'
import type { Tool } from '../src/tools/types'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

const servers: http.Server[] = []
const sockets = new Set<Socket>()

const denialBody = JSON.stringify({
  content: [{ type: 'text', text: 'Access Denied: this key may not call chat completions' }],
})

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
    messages: [{ role: 'user', content: [{ type: 'text', text: 'create a file' }] }],
    tools: [],
    maxTokens: 64,
    signal,
  }
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function openAi(url: string): Provider {
  return createOpenAiProvider({ id: 'gateway', apiKey: 'sk-test', baseUrl: `${url}/v1` })
}

function sse(delta: object, finishReason: string | null): string {
  const chunk = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function jsonServer(body: string): Promise<string> {
  return startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
}

describe('a 200 that is not a streaming chat completion', () => {
  it('fails loudly through the openai adapter and shows the body', async () => {
    const provider = openAi(await jsonServer(denialBody))

    const events = collect(provider.stream(chatRequest()))
    await expect(events).rejects.toBeInstanceOf(ProviderError)
    await expect(events).rejects.toThrow(/Access Denied/)
    await expect(events).rejects.toThrow(/not a valid streaming chat completion/)
  })

  it('fails loudly through the anthropic adapter and shows the body', async () => {
    const url = await jsonServer(denialBody)
    const provider = createAnthropicProvider({ id: 'gateway', apiKey: 'sk-test', baseUrl: url })

    const events = collect(provider.stream(chatRequest()))
    await expect(events).rejects.toBeInstanceOf(ProviderError)
    await expect(events).rejects.toThrow(/Access Denied/)
  })

  it('fails loudly when the 200 body is empty', async () => {
    const provider = openAi(await jsonServer(''))

    const events = collect(provider.stream(chatRequest()))
    await expect(events).rejects.toBeInstanceOf(ProviderError)
    await expect(events).rejects.toThrow(/not a valid streaming chat completion.*body was empty/s)
  })

  it('fails loudly on a stream of anthropic events with no chat-completion chunks', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Access Denied"}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      )
    })

    const events = collect(openAi(url).stream(chatRequest()))
    await expect(events).rejects.toBeInstanceOf(ProviderError)
    await expect(events).rejects.toThrow(/not a valid streaming chat completion/)
    await expect(events).rejects.toThrow(/Access Denied/)
  })

  it('still blames the connection when a 200 body is cut off mid-stream', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"messa')
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const anthropic = createAnthropicProvider({ id: 'gateway', apiKey: 'sk-test', baseUrl: url })

    const error = await collect(anthropic.stream(chatRequest())).catch((thrown) => thrown)
    expect((error as Error).message).toMatch(/Cannot reach "gateway"/)
    expect((error as Error).message).not.toMatch(/not a valid streaming chat completion/)
  })

  it('redacts a key echoed back by the endpoint', async () => {
    const text = 'bad key sk-live-abcdef123456'
    const provider = openAi(await jsonServer(JSON.stringify({ content: [{ type: 'text', text }] })))

    const error = await collect(provider.stream(chatRequest())).catch((thrown) => thrown)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as Error).message).not.toContain('sk-live-abcdef123456')
    expect((error as Error).message).toContain('[redacted]')
  })
})

describe('legitimate turns still work', () => {
  async function sseServer(body: string): Promise<string> {
    return startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${body}data: [DONE]\n\n`)
    })
  }

  it('accepts an SSE turn that is only a tool call', async () => {
    const call = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'write', arguments: '{"path":"a.txt"}' },
    }
    const provider = openAi(
      await sseServer(sse({ tool_calls: [call] }, null) + sse({}, 'tool_calls')),
    )

    const events = await collect(provider.stream(chatRequest()))
    expect(events.find((event) => event.type === 'done')).toMatchObject({ stopReason: 'tool_use' })
    expect(events.some((event) => event.type === 'tool_call')).toBe(true)
  })

  it('rejects malformed tool arguments instead of executing an empty object', async () => {
    const call = {
      index: 0,
      id: 'call_broken',
      type: 'function',
      function: { name: 'write', arguments: '{"path":' },
    }
    const provider = openAi(
      await sseServer(sse({ tool_calls: [call] }, null) + sse({}, 'tool_calls')),
    )

    const events = collect(provider.stream(chatRequest()))
    await expect(events).rejects.toBeInstanceOf(ProviderError)
    await expect(events).rejects.toThrow(/malformed JSON arguments; the tool was not run/)
  })

  it('treats a user cancellation during partial tool JSON as a normal cancellation', async () => {
    const call = {
      index: 0,
      id: 'call_cancelled',
      type: 'function',
      function: { name: 'write', arguments: '{"path":' },
    }
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ tool_calls: [call] }, null))
    })
    const controller = new AbortController()
    const events = collect(openAi(url).stream(chatRequest(controller.signal)))
    setTimeout(() => controller.abort(), 20)

    await expect(events).resolves.toContainEqual(
      expect.objectContaining({ type: 'done', stopReason: 'aborted', content: [] }),
    )
  })

  it('rejects non-object JSON tool arguments', async () => {
    const call = {
      index: 0,
      id: 'call_array',
      type: 'function',
      function: { name: 'write', arguments: '[]' },
    }
    const provider = openAi(
      await sseServer(sse({ tool_calls: [call] }, null) + sse({}, 'tool_calls')),
    )

    await expect(collect(provider.stream(chatRequest()))).rejects.toThrow(
      /arguments must be a JSON object; the tool was not run/,
    )
  })

  it('accepts an SSE turn whose only text is whitespace', async () => {
    const provider = openAi(await sseServer(sse({ content: '   ' }, null) + sse({}, 'stop')))

    const events = await collect(provider.stream(chatRequest()))
    expect(events.find((event) => event.type === 'done')).toMatchObject({ stopReason: 'end_turn' })
  })

  it('accepts a final chunk that carries usage and an empty choices array', async () => {
    const usageChunk =
      'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n'
    const provider = openAi(await sseServer(sse({ content: 'hi' }, 'stop') + usageChunk))

    const events = await collect(provider.stream(chatRequest()))
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      usage: { input: 7, output: 2 },
    })
  })
})

function stubProvider(events: StreamEvent[]): Provider {
  return {
    id: 'gateway',
    kind: 'openai',
    stream: async function* () {
      for (const event of events) yield event
    },
    listModels: async () => [],
    knownModels: () => [],
  }
}

function agentConfig(provider: Provider): AgentConfig {
  return {
    provider,
    modelId: 'test-model',
    modelRef: 'gateway/test-model',
    system: 'be brief',
    tools: { get: () => undefined, schemas: () => [] },
    permissions: { decide: () => 'allow', grantForSession: () => {} },
    usage: { record: () => {} },
    cwd: process.cwd(),
    maxTokens: 64,
    effort: 'medium',
    thinking: false,
  }
}

function recordingHooks(): { hooks: AgentHooks; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return {
    events,
    hooks: { onEvent: (event) => events.push(event), requestPermission: async () => 'deny' },
  }
}

describe('runTurn refuses to fabricate a finished turn', () => {
  it('surfaces the body of a non-streaming 200 through a whole turn', async () => {
    const { hooks, events } = recordingHooks()
    const provider = openAi(await jsonServer(denialBody))
    const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]

    await expect(
      runTurn(agentConfig(provider), history, hooks, new AbortController().signal),
    ).rejects.toThrow(/Access Denied/)
    expect(events.some((event) => event.type === 'turn_end')).toBe(false)
  })

  it('throws when the provider stream ends with no done event', async () => {
    const { hooks, events } = recordingHooks()
    const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]

    await expect(
      runTurn(agentConfig(stubProvider([])), history, hooks, new AbortController().signal),
    ).rejects.toThrow(/without completing the turn/)
    expect(events.some((event) => event.type === 'turn_end')).toBe(false)
  })

  it('still reports an aborted turn as aborted', async () => {
    const { hooks, events } = recordingHooks()
    const controller = new AbortController()
    controller.abort()
    const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]

    await runTurn(agentConfig(stubProvider([])), history, hooks, controller.signal)
    expect(events).toContainEqual({ type: 'turn_end', stopReason: 'aborted' })
  })

  it('does not execute an oversized batch of tool calls', async () => {
    const { hooks, events } = recordingHooks()
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_STEP + 1 }, (_, index) => ({
      type: 'tool_use' as const,
      id: `call_${index}`,
      name: 'unknown',
      input: {},
    }))
    const provider = stubProvider([
      { type: 'done', stopReason: 'tool_use', content: calls },
    ])
    const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }]

    await expect(
      runTurn(agentConfig(provider), history, hooks, new AbortController().signal),
    ).resolves.toEqual(history)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'notice', text: expect.stringContaining('None were run') }),
    )
  })

  it('serializes permission prompts and stateful tool calls in model order', async () => {
    let modelCall = 0
    const provider: Provider = {
      id: 'gateway',
      kind: 'openai',
      listModels: async () => [],
      knownModels: () => [],
      async *stream() {
        if (modelCall++ === 0) {
          yield {
            type: 'done' as const,
            stopReason: 'tool_use' as const,
            content: [
              { type: 'tool_use' as const, id: 'first', name: 'stateful', input: { order: 1 } },
              { type: 'tool_use' as const, id: 'second', name: 'stateful', input: { order: 2 } },
            ],
          }
          return
        }
        yield {
          type: 'done' as const,
          stopReason: 'end_turn' as const,
          content: [{ type: 'text' as const, text: 'done' }],
        }
      },
    }
    const executed: number[] = []
    const tool: Tool = {
      name: 'stateful',
      description: 'stateful test tool',
      inputSchema: { type: 'object' },
      defaultPermission: 'ask',
      summarize: () => 'stateful call',
      execute: async (input) => {
        executed.push((input as { order: number }).order)
        return { content: 'ok' }
      },
    }
    let activePrompts = 0
    let maxActivePrompts = 0
    const hooks: AgentHooks = {
      onEvent: () => undefined,
      requestPermission: async () => {
        activePrompts += 1
        maxActivePrompts = Math.max(maxActivePrompts, activePrompts)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activePrompts -= 1
        return 'once'
      },
    }
    const config: AgentConfig = {
      ...agentConfig(provider),
      tools: {
        get: (name) => (name === tool.name ? tool : undefined),
        schemas: () => [],
      },
      permissions: { decide: () => 'ask', grantForSession: () => undefined },
    }

    await runTurn(
      config,
      [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks,
      new AbortController().signal,
    )

    expect(maxActivePrompts).toBe(1)
    expect(executed).toEqual([1, 2])
  })
})

describe('detection honours the advertised protocol', () => {
  const anthropicShaped = {
    data: [
      {
        id: 'claude-opus-5',
        object: 'model',
        owned_by: 'anthropic',
        supported_endpoint_types: ['anthropic'],
      },
    ],
  }

  it('classifies a Bearer-authenticated list advertising anthropic as anthropic', async () => {
    const url = await jsonServer(JSON.stringify(anthropicShaped))
    const detected = await detectProvider(`${url}/v1`, 'sk-test')
    expect(detected.config.type).toBe('anthropic')
    expect(detected.models.map((model) => model.id)).toEqual(['claude-opus-5'])
  })

  it('leaves a plain model list as openai', async () => {
    const body = JSON.stringify({ data: [{ id: 'gpt-5', object: 'model', owned_by: 'openai' }] })
    const detected = await detectProvider(`${await jsonServer(body)}/v1`, 'sk-test')
    expect(detected.config.type).toBe('openai')
  })

  it('strips the trailing /v1 so the anthropic client does not double it', async () => {
    const url = await jsonServer(JSON.stringify(anthropicShaped))
    expect((await detectProvider(`${url}/v1`, 'sk-test')).config.baseUrl).toBe(url)
  })

  it('leaves an aggregator serving anthropic-owned namespaced ids as openai', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'anthropic/claude-opus-5', object: 'model', owned_by: 'anthropic' },
        { id: 'anthropic/claude-sonnet-5', object: 'model', owned_by: 'anthropic' },
      ],
    })
    const url = await jsonServer(body)
    const detected = await detectProvider(`${url}/v1`, 'sk-test')
    expect(detected.config.type).toBe('openai')
    expect(detected.config.baseUrl).toBe(`${url}/v1`)
  })

  it('leaves a mixed advertisement as openai', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'claude-opus-5', supported_endpoint_types: ['anthropic'] },
        { id: 'gpt-5', supported_endpoint_types: ['openai'] },
      ],
    })
    const detected = await detectProvider(`${await jsonServer(body)}/v1`, 'sk-test')
    expect(detected.config.type).toBe('openai')
  })
})
