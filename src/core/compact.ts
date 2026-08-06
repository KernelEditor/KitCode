import type {
  ContentBlock,
  Message,
  Provider,
  RateLimits,
  Usage,
} from '../providers/types'

const KEEP_USER_TURNS = 2
const MAX_SOURCE_CHARS = 500_000
const MAX_TOOL_RESULT_CHARS = 8_000
const MAX_TEXT_BLOCK_CHARS = 50_000

export interface CompactResult {
  history: Message[]
  compacted: boolean
  removedMessages: number
  usage?: Usage
  rateLimits?: RateLimits
}

export async function compactHistory(options: {
  provider: Provider
  model: string
  history: Message[]
  maxTokens: number
  signal: AbortSignal
}): Promise<CompactResult> {
  const cut = compactCutIndex(options.history)
  if (cut <= 0) {
    return { history: options.history, compacted: false, removedMessages: 0 }
  }

  const source = renderHistory(options.history.slice(0, cut))
  if (!source.trim()) {
    return { history: options.history, compacted: false, removedMessages: 0 }
  }

  let summary = ''
  let finalText = ''
  let usage: Usage | undefined
  let rateLimits: RateLimits | undefined
  const stream = options.provider.stream({
    model: options.model,
    system:
      'Summarize the earlier coding conversation for another agent. Preserve concrete requirements, user preferences, architectural decisions, commands and files changed, test results, bugs, errors, and unfinished work. Be concise but lossless. Do not include private chain-of-thought or invent details. Return only the durable summary.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Earlier conversation to compact:\n\n${source}` }],
      },
    ],
    tools: [],
    maxTokens: Math.max(512, Math.min(4_096, options.maxTokens)),
    thinking: false,
    signal: options.signal,
  })

  for await (const event of stream) {
    if (event.type === 'text_delta') summary += event.text
    else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'rate_limits') rateLimits = event.limits
    else if (event.type === 'done') {
      finalText = event.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
    }
  }

  summary = (finalText || summary).trim()
  if (!summary) throw new Error('The provider returned an empty context summary.')

  const prefix: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `[Earlier conversation summary]\n${summary}` }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Earlier context loaded. I will continue from this summary.' }],
    },
  ]
  return {
    history: [...prefix, ...options.history.slice(cut)],
    compacted: true,
    removedMessages: cut,
    usage,
    rateLimits,
  }
}

export function shouldAutoCompact(used: number, window: number | null): boolean {
  return window !== null && window > 0 && used / window >= 0.8
}

export function compactCutIndex(history: Message[]): number {
  const userTurns: number[] = []
  for (const [index, message] of history.entries()) {
    if (isConversationUser(message)) userTurns.push(index)
  }
  if (userTurns.length <= KEEP_USER_TURNS) return 0
  return userTurns[userTurns.length - KEEP_USER_TURNS] ?? 0
}

export function estimateCompactTokens(history: Message[]): number {
  const cut = compactCutIndex(history)
  if (cut <= 0) return 1
  return Math.max(1, renderHistory(history.slice(0, cut)).length + 1_000)
}

function isConversationUser(message: Message): boolean {
  if (message.role !== 'user') return false
  return message.content.some(
    (block) =>
      block.type === 'image' ||
      block.type === 'file' ||
      (block.type === 'text' && !block.text.startsWith('[Earlier conversation summary]')),
  )
}

function renderHistory(history: Message[]): string {
  let result = ''
  for (const message of history) {
    const blocks = message.content.map(renderBlock).filter(Boolean)
    if (blocks.length === 0) continue
    const part = `${message.role.toUpperCase()}:\n${blocks.join('\n\n')}`
    if (result.length + part.length > MAX_SOURCE_CHARS) {
      result += '\n\n[...older context truncated for compaction...]'
      break
    }
    result += (result ? '\n\n' : '') + part
  }
  return result
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return truncate(block.text, MAX_TEXT_BLOCK_CHARS)
    case 'thinking':
      return ''
    case 'image':
      return `[Image attached: ${block.name}]`
    case 'file':
      return `[File attached: ${block.name}]\n${truncate(block.text, MAX_TOOL_RESULT_CHARS)}`
    case 'tool_use':
      return `[Tool call: ${block.name}]\n${safeJson(block.input)}`
    case 'tool_result':
      return `[Tool result${block.isError ? ' (error)' : ''}]\n${truncate(block.content, MAX_TOOL_RESULT_CHARS)}`
  }
}

function safeJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value, null, 2), MAX_TOOL_RESULT_CHARS)
  } catch {
    return '[unserializable input]'
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[...truncated...]`
}
