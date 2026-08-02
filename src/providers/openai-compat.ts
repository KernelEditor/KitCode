import OpenAI from 'openai'
import {
  captureResponseHead,
  invalidStreamError,
  isUserAbort,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
  toProviderError,
} from './errors'
import { modelInfoFromRaw } from './model-info'
import { pricingFor } from './pricing'
import { emptyUsage } from './types'
import type {
  ChatRequest,
  ContentBlock,
  Message,
  ModelInfo,
  Provider,
  StopReason,
  StreamEvent,
  ToolSchema,
  ToolUseBlock,
  Usage,
} from './types'

const FINISH_REASONS: Record<string, StopReason> = {
  tool_calls: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
}

interface PartialCall {
  id: string
  name: string
  args: string
}

type ReasoningDelta = { reasoning_content?: string | null; reasoning?: string | null }

type ToolCallDelta = OpenAI.Chat.ChatCompletionChunk.Choice.Delta.ToolCall

export function createOpenAiProvider(args: {
  id: string
  apiKey: string
  baseUrl: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Provider {
  const client = new OpenAI({
    baseURL: args.baseUrl,
    apiKey: args.apiKey,
    defaultHeaders: args.headers,
    maxRetries: MAX_RETRIES,
    timeout: args.timeoutMs ?? REQUEST_TIMEOUT_MS,
  })

  return {
    id: args.id,
    kind: 'openai',
    stream: (req) => streamTurn(client, args.id, req),
    listModels: () => listModels(client, args.id),
    knownModels: () => [],
  }
}

async function* streamTurn(
  client: OpenAI,
  providerId: string,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  let text = ''
  let thinking = ''
  let finishReason: string | null = null
  let aborted = false
  let usage = emptyUsage()
  let recognised = 0
  const calls = new Map<number, PartialCall>()
  const capture = captureResponseHead()

  try {
    const stream = await client.withOptions({ fetch: capture.fetch }).chat.completions.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: toChatMessages(req.system, req.messages),
        ...(req.tools.length > 0 ? { tools: toChatTools(req.tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    )

    for await (const chunk of stream) {
      if (chunk.usage) usage = toUsage(chunk.usage)
      if (!Array.isArray(chunk.choices)) continue
      recognised += 1
      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta as typeof choice.delta & ReasoningDelta
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reasoning) {
        thinking += reasoning
        yield { type: 'thinking_delta', text: reasoning }
      }
      if (delta.content) {
        text += delta.content
        yield { type: 'text_delta', text: delta.content }
      }
      for (const call of delta.tool_calls ?? []) accumulate(calls, call)
    }
  } catch (error) {
    if (!isUserAbort(error, req.signal)) throw toProviderError(error, providerId)
    aborted = true
  }

  const content = toContentBlocks(thinking, text, calls)
  if (aborted || req.signal?.aborted) {
    yield { type: 'usage', usage }
    yield { type: 'done', stopReason: 'aborted', content }
    return
  }

  if (recognised === 0) throw await invalidStreamError(providerId, capture)

  for (const block of content) {
    if (block.type === 'tool_use') {
      yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
    }
  }
  yield { type: 'usage', usage }
  yield { type: 'done', stopReason: resolveStop(finishReason, calls.size > 0), content }
}

function resolveStop(finishReason: string | null, hasCalls: boolean): StopReason {
  const mapped = FINISH_REASONS[finishReason ?? '']
  if (mapped === 'max_tokens' || mapped === 'refusal') return mapped
  if (hasCalls) return 'tool_use'
  return mapped ?? 'end_turn'
}

async function listModels(client: OpenAI, providerId: string): Promise<ModelInfo[]> {
  try {
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      const metadata = modelInfoFromRaw(model) ?? { id: model.id }
      models.push({ ...metadata, pricing: metadata.pricing ?? pricingFor(model.id) })
    }
    return models
  } catch (error) {
    throw toProviderError(error, providerId)
  }
}

function accumulate(calls: Map<number, PartialCall>, delta: ToolCallDelta): void {
  const call = calls.get(delta.index) ?? { id: '', name: '', args: '' }
  if (delta.id) call.id += delta.id
  if (delta.function?.name) call.name += delta.function.name
  if (delta.function?.arguments) call.args += delta.function.arguments
  calls.set(delta.index, call)
}

function toContentBlocks(
  thinking: string,
  text: string,
  calls: Map<number, PartialCall>,
): ContentBlock[] {
  const content: ContentBlock[] = []
  if (thinking) content.push({ type: 'thinking', text: thinking })
  if (text) content.push({ type: 'text', text })
  const sorted = [...calls.entries()].sort((a, b) => a[0] - b[0])
  const tmpId = (position: number) => `call_${position}`
  for (const [position, [, call]] of sorted.entries()) {
    content.push({
      type: 'tool_use',
      id: call.id || tmpId(position),
      name: call.name,
      input: parseArguments(call.args),
    })
  }
  return content
}

function parseArguments(args: string): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

function toChatMessages(
  system: string,
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'assistant') out.push(...toAssistantMessage(message.content))
    else out.push(...toUserMessages(message.content))
  }
  return out
}

function toUserMessages(content: ContentBlock[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
    }
  }
  const text = joinText(content)
  if (text) out.push({ role: 'user', content: text })
  return out
}

function toAssistantMessage(content: ContentBlock[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const toolCalls = content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }))
  const text = joinText(content)
  if (!text && toolCalls.length === 0) return []
  const message: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: text || null,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return [message]
}

function joinText(content: ContentBlock[]): string {
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

function toChatTools(tools: ToolSchema[]): OpenAI.Chat.ChatCompletionFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function toUsage(usage: NonNullable<OpenAI.Chat.ChatCompletionChunk['usage']>): Usage {
  return normalizeOpenAiUsage(usage)
}

export function normalizeOpenAiUsage(usage: {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
}): Usage {
  // OpenAI reports cached tokens as a subset of prompt_tokens. Internally all
  // usage buckets are exclusive so pricing and context totals can safely add
  // them without counting the cached portion twice.
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead),
    output: usage.completion_tokens ?? 0,
    cacheWrite: 0,
    cacheRead,
  }
}
