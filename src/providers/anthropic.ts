import Anthropic from '@anthropic-ai/sdk'
import {
  captureResponseHead,
  invalidStreamError,
  isConnectionFailure,
  isUserAbort,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
  toProviderError,
} from './errors'
import { pricingFor } from './pricing'
import type {
  ChatRequest,
  ContentBlock,
  Message,
  ModelInfo,
  Provider,
  StopReason,
  StreamEvent,
  ToolSchema,
  Usage,
} from './types'

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  pause_turn: 'pause_turn',
  refusal: 'refusal',
}

const KNOWN_MODELS: ModelInfo[] = [
  knownModel('claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000),
  knownModel('claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, 128_000),
  knownModel('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000),
  knownModel('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000),
  knownModel('claude-fable-5', 'Claude Fable 5', 1_000_000, 128_000),
]

export function createAnthropicProvider(args: {
  id: string
  apiKey: string
  baseUrl?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Provider {
  const client = new Anthropic({
    apiKey: args.apiKey,
    baseURL: args.baseUrl,
    defaultHeaders: args.headers,
    maxRetries: MAX_RETRIES,
    timeout: args.timeoutMs ?? REQUEST_TIMEOUT_MS,
  })

  return {
    id: args.id,
    kind: 'anthropic',
    stream: (req) => streamTurn(client, args.id, req),
    listModels: () => listModels(client, args.id),
    knownModels: () => KNOWN_MODELS,
  }
}

async function* streamTurn(
  client: Anthropic,
  providerId: string,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  const params: Anthropic.MessageStreamParams = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: toMessageParams(req.messages),
    tools: toToolParams(req.tools),
  }
  if (req.thinking) params.thinking = { type: 'adaptive', display: 'summarized' }
  if (req.effort) params.output_config = { effort: req.effort }

  let thinking = ''
  let text = ''
  let events = 0
  let final: Anthropic.Message
  const capture = captureResponseHead()
  const stream = client
    .withOptions({ fetch: capture.fetch })
    .messages.stream(params, { signal: req.signal })

  try {
    for await (const event of stream) {
      events += 1
      if (event.type !== 'content_block_delta') continue
      if (event.delta.type === 'text_delta') {
        text += event.delta.text
        yield { type: 'text_delta', text: event.delta.text }
      } else if (event.delta.type === 'thinking_delta') {
        thinking += event.delta.thinking
        yield { type: 'thinking_delta', text: event.delta.thinking }
      }
    }
    final = await stream.finalMessage()
  } catch (error) {
    if (isUserAbort(error, req.signal)) {
      const partial = stream.currentMessage
      if (partial) yield { type: 'usage', usage: toUsage(partial.usage) }
      yield { type: 'done', stopReason: 'aborted', content: partialContent(thinking, text) }
      return
    }
    if (events === 0 && capture.succeeded() && !isConnectionFailure(error)) {
      throw await invalidStreamError(providerId, capture, error)
    }
    throw toProviderError(error, providerId)
  }

  const stopReason = STOP_REASONS[final.stop_reason ?? ''] ?? 'end_turn'
  const content = toContentBlocks(final.content)

  for (const block of content) {
    if (block.type === 'tool_use') {
      yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
    }
  }
  yield { type: 'usage', usage: toUsage(final.usage) }
  yield {
    type: 'done',
    stopReason,
    content,
    ...(stopReason === 'refusal' ? { refusal: toRefusal(final.stop_details) } : {}),
  }
}

async function listModels(client: Anthropic, providerId: string): Promise<ModelInfo[]> {
  try {
    const models: ModelInfo[] = []
    for await (const model of client.models.list({ limit: 100 })) {
      models.push({
        id: model.id,
        name: model.display_name,
        contextWindow: model.max_input_tokens ?? undefined,
        maxOutput: model.max_tokens ?? undefined,
        pricing: pricingFor(model.id),
      })
    }
    return models
  } catch (error) {
    throw toProviderError(error, providerId)
  }
}

function toMessageParams(messages: Message[]): Anthropic.MessageParam[] {
  const params: Anthropic.MessageParam[] = []
  for (const message of messages) {
    const content = message.content.flatMap(toBlockParams)
    if (content.length > 0) params.push({ role: message.role, content })
  }
  return params
}

function toBlockParams(block: ContentBlock): Anthropic.ContentBlockParam[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }]
    case 'thinking':
      return block.raw ? [block.raw as Anthropic.ContentBlockParam] : []
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        },
      ]
  }
}

function toToolParams(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((tool, index) => {
    const param: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }
    if (index === tools.length - 1) param.cache_control = { type: 'ephemeral' }
    return param
  })
}

function toContentBlocks(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const content: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking')
      content.push({ type: 'thinking', text: block.thinking, raw: block })
    else if (block.type === 'redacted_thinking')
      content.push({ type: 'thinking', text: '', raw: block })
    else if (block.type === 'tool_use')
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
  }
  return content
}

function partialContent(thinking: string, text: string): ContentBlock[] {
  const content: ContentBlock[] = []
  if (thinking) content.push({ type: 'thinking', text: thinking })
  if (text) content.push({ type: 'text', text })
  return content
}

function toUsage(usage: Anthropic.Usage): Usage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  }
}

function toRefusal(details: Anthropic.RefusalStopDetails | null) {
  return { category: details?.category ?? null, explanation: details?.explanation ?? null }
}

function knownModel(id: string, name: string, contextWindow: number, maxOutput: number): ModelInfo {
  return { id, name, contextWindow, maxOutput, pricing: pricingFor(id) }
}
