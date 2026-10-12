import { effectiveEffort, markEffortRejected } from './effort'
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
import { parseRateLimits } from './rate-limits'
import { emptyUsage, ProviderError } from './types'
import type {
  Effort,
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
    stream: (req) => streamTurn(client, args.id, args.apiKey, req),
    listModels: () => listModels(client, args.id, args.apiKey),
    knownModels: () => [],
  }
}

async function* streamTurn(
  client: OpenAI,
  providerId: string,
  apiKey: string,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  let effort = effectiveEffort('openai', req.model, req.effort, req.messages, providerId)
  const thinkingKey = `${providerId}/${req.model}`
  let thinkingOff = req.thinking === false && !thinkingOffRejected.has(thinkingKey)
    ? thinkingOffParams(req.model)
    : undefined
  let tokenField: TokenField = completionTokenModels.has(thinkingKey) || usesCompletionTokens(req.model)
    ? 'max_completion_tokens'
    : 'max_tokens'
  // At most one retry per optional field the endpoint turns out to reject.
  for (;;) {
    let streamed = false
    try {
      for await (const event of streamOnce(client, providerId, apiKey, req, effort, thinkingOff, tokenField)) {
        if (event.type !== 'rate_limits' && event.type !== 'usage') streamed = true
        yield event
      }
      return
    } catch (error) {
      if (streamed) throw error
      if (tokenField === 'max_tokens' && rejectsField(error, /max_completion_tokens/)) {
        completionTokenModels.add(thinkingKey)
        tokenField = 'max_completion_tokens'
        continue
      }
      if (effort && rejectsField(error, /reasoning|effort/i)) {
        // Stop sending reasoning_effort for this model (the status bar then
        // shows effort as unsupported) and retry.
        markEffortRejected(providerId, req.model)
        effort = undefined
        continue
      }
      if (thinkingOff && rejectsField(error, /thinking/i)) {
        thinkingOffRejected.add(thinkingKey)
        thinkingOff = undefined
        continue
      }
      throw error
    }
  }
}

// provider/model pairs whose endpoint rejected the thinking switch.
const thinkingOffRejected = new Set<string>()

type TokenField = 'max_tokens' | 'max_completion_tokens'
// provider/model pairs that asked for max_completion_tokens instead.
const completionTokenModels = new Set<string>()

/** OpenAI's reasoning models reject max_tokens and require max_completion_tokens. */
function usesCompletionTokens(model: string): boolean {
  const id = (model.split('/').at(-1) ?? model).toLowerCase()
  return /^(?:o[1-9](?:-|$)|gpt-5(?:[.-]|$))/.test(id)
}

/** Request fields that turn reasoning off for model families known to accept them. */
function thinkingOffParams(model: string): Record<string, unknown> | undefined {
  const id = (model.split('/').at(-1) ?? model).toLowerCase()
  if (/^(?:glm-4\.[5-9]|glm-[5-9]|kimi-k(?:2\.[5-9]|[3-9]))/.test(id)) return { thinking: { type: 'disabled' } }
  if (/^(?:qwen3|qwq)/.test(id)) return { enable_thinking: false }
  return undefined
}

function rejectsField(error: unknown, field: RegExp): boolean {
  if (!(error instanceof ProviderError) || (error.status !== 400 && error.status !== 422)) return false
  const cause = error.cause instanceof Error ? error.cause.message : ''
  return field.test(`${error.message} ${cause}`)
}

async function* streamOnce(
  client: OpenAI,
  providerId: string,
  apiKey: string,
  req: ChatRequest,
  effort: Exclude<Effort, 'auto'> | undefined,
  thinkingOff: Record<string, unknown> | undefined,
  tokenField: TokenField,
): AsyncGenerator<StreamEvent> {
  let text = ''
  let thinking = ''
  let finishReason: string | null = null
  let aborted = false
  let usage = emptyUsage()
  let sawUsage = false
  let recognised = 0
  const calls = new Map<number, PartialCall>()
  const capture = captureResponseHead()

  try {
    const stream = await client.withOptions({ fetch: capture.fetch }).chat.completions.create(
      {
        model: req.model,
        [tokenField]: req.maxTokens,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...thinkingOff,
        messages: toChatMessages(req.system, req.messages),
        ...(req.tools.length > 0 ? { tools: toChatTools(req.tools) } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    )

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = toUsage(chunk.usage)
        sawUsage = true
      }
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
    if (!isUserAbort(error, req.signal)) {
      if (sawUsage) yield { type: 'usage', usage }
      const limits = parseRateLimits(capture.headers())
      if (limits) yield { type: 'rate_limits', limits }
      throw toProviderError(error, providerId, [apiKey])
    }
    aborted = true
  }

  if (aborted || req.signal?.aborted) {
    // A cancelled stream may end halfway through a tool-call JSON payload. Do
    // not parse or surface that partial call: no tool is going to run.
    const content = toTextContentBlocks(thinking, text)
    if (sawUsage) yield { type: 'usage', usage }
    const limits = parseRateLimits(capture.headers())
    if (limits) yield { type: 'rate_limits', limits }
    yield { type: 'done', stopReason: 'aborted', content }
    return
  }

  if (recognised === 0) throw await invalidStreamError(providerId, capture, undefined, [apiKey])

  if (sawUsage) yield { type: 'usage', usage }
  const content = toContentBlocks(providerId, thinking, text, calls)
  for (const block of content) {
    if (block.type === 'tool_use') {
      yield { type: 'tool_call', id: block.id, name: block.name, input: block.input }
    }
  }
  const limits = parseRateLimits(capture.headers())
  if (limits) yield { type: 'rate_limits', limits }
  yield { type: 'done', stopReason: resolveStop(finishReason, calls.size > 0), content }
}

function resolveStop(finishReason: string | null, hasCalls: boolean): StopReason {
  const mapped = FINISH_REASONS[finishReason ?? '']
  if (mapped === 'max_tokens' || mapped === 'refusal') return mapped
  if (hasCalls) return 'tool_use'
  return mapped ?? 'end_turn'
}

async function listModels(client: OpenAI, providerId: string, apiKey: string): Promise<ModelInfo[]> {
  try {
    const models: ModelInfo[] = []
    for await (const model of client.models.list()) {
      const metadata = modelInfoFromRaw(model) ?? { id: model.id }
      models.push({ ...metadata, pricing: metadata.pricing ?? pricingFor(model.id) })
    }
    return models
  } catch (error) {
    throw toProviderError(error, providerId, [apiKey])
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
  providerId: string,
  thinking: string,
  text: string,
  calls: Map<number, PartialCall>,
): ContentBlock[] {
  const content = toTextContentBlocks(thinking, text)
  const sorted = [...calls.entries()].sort((a, b) => a[0] - b[0])
  const tmpId = (position: number) => `call_${position}`
  for (const [position, [, call]] of sorted.entries()) {
    content.push({
      type: 'tool_use',
      id: call.id || tmpId(position),
      name: call.name,
      input: parseArguments(providerId, call.name, call.args),
    })
  }
  return content
}

function toTextContentBlocks(thinking: string, text: string): ContentBlock[] {
  const content: ContentBlock[] = []
  if (thinking) content.push({ type: 'thinking', text: thinking })
  if (text) content.push({ type: 'text', text })
  return content
}

function parseArguments(
  providerId: string,
  toolName: string,
  args: string,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    throw new ProviderError(
      `Tool "${toolName || 'unknown'}" returned malformed JSON arguments; the tool was not run.`,
      providerId,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `Tool "${toolName || 'unknown'}" arguments must be a JSON object; the tool was not run.`,
      providerId,
    )
  }
  return parsed as Record<string, unknown>
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
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    if (block.type === 'file') {
      parts.push({ type: 'text', text: `[Attached file: ${block.name}]\n${block.text}` })
    }
    if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      })
    }
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    out.push({ role: 'user', content: parts[0].text })
  } else if (parts.length > 0) {
    out.push({ role: 'user', content: parts })
  }
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
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null
  // DeepSeek reports cache hits outside prompt_tokens_details.
  prompt_cache_hit_tokens?: number | null
  // Moonshot/Kimi put cached_tokens at the top level.
  cached_tokens?: number | null
}): Usage {
  // prompt_tokens includes cached and cache-written tokens; split them out so
  // input is billed at the uncached rate only once.
  const prompt = count(usage.prompt_tokens)
  const cacheRead = Math.min(
    prompt,
    count(usage.prompt_tokens_details?.cached_tokens) ||
      count(usage.prompt_cache_hit_tokens) ||
      count(usage.cached_tokens),
  )
  const cacheWrite = Math.min(prompt - cacheRead, count(usage.prompt_tokens_details?.cache_write_tokens))
  return {
    input: prompt - cacheRead - cacheWrite,
    output: count(usage.completion_tokens),
    cacheWrite,
    cacheRead,
  }
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
