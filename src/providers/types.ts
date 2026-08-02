export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type JsonSchema = Record<string, unknown>

export interface ModelPricing {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
}

export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxOutput?: number
  pricing?: ModelPricing
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  raw?: unknown
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

export interface ImageBlock {
  type: 'image'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
  name: string
}

export interface FileBlock {
  type: 'file'
  mediaType: string
  text: string
  name: string
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | FileBlock

export type MessageRole = 'user' | 'assistant'

export interface Message {
  role: MessageRole
  content: ContentBlock[]
}

export interface ChatRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolSchema[]
  maxTokens: number
  effort?: Effort
  thinking?: boolean
  signal?: AbortSignal
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'pause_turn'
  | 'refusal'
  | 'aborted'

export interface Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface RefusalInfo {
  category?: string | null
  explanation?: string | null
}

export interface RateLimitBucket {
  limit?: number
  remaining?: number
  reset?: string
}

export interface RateLimits {
  requests?: RateLimitBucket
  tokens?: RateLimitBucket
  inputTokens?: RateLimitBucket
  outputTokens?: RateLimitBucket
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'rate_limits'; limits: RateLimits }
  | { type: 'done'; stopReason: StopReason; content: ContentBlock[]; refusal?: RefusalInfo }

export type ProviderKind = 'anthropic' | 'openai'

export interface Provider {
  readonly id: string
  readonly kind: ProviderKind
  stream(req: ChatRequest): AsyncIterable<StreamEvent>
  listModels(): Promise<ModelInfo[]>
  knownModels(): ModelInfo[]
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProviderError'
  }
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  }
}
