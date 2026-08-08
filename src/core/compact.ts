import type {
  ContentBlock,
  Message,
  Provider,
  RateLimits,
  Usage,
} from '../providers/types'

const KEEP_USER_TURNS = 2

// Size thresholds for deciding the summarization strategy
const SINGLE_REQUEST_MAX_CHARS = 80_000
const CHUNK_TARGET_CHARS = 35_000
const CHUNK_OVERLAP_MESSAGES = 2
const CHUNK_OVERLAP_MAX_CHARS = 4_000
const MERGE_TARGET_CHARS = 60_000

// Keep requirements more generously than generated prose and noisy tool output.
const MAX_USER_TEXT_CHARS = 12_000
const MAX_ASSISTANT_TEXT_CHARS = 6_000
const MAX_FILE_BLOCK_CHARS = 2_000
const MAX_TOOL_RESULT_CHARS = 1_200
const MAX_TOOL_ERROR_CHARS = 2_000
const MAX_TOOL_INPUT_CHARS = 800

// Output token limits — tight, because a good summary is concise
const SINGLE_MAX_TOKENS = 768
const CHUNK_MAX_TOKENS = 512
const MERGE_MAX_TOKENS = 1_024

// Concurrency for parallel chunk summarization
const CHUNK_CONCURRENCY = 3

const SYSTEM_SUMMARIZE =
  'You are summarizing a coding conversation so another agent can continue the work. ' +
  'Extract and preserve ONLY: concrete requirements, user preferences, files changed, ' +
  'commands run and their results, errors encountered, bugs found, architectural decisions, ' +
  'and unfinished work. Be terse and factual. Do NOT include greetings, acknowledgments, ' +
  'chain-of-thought, or step-by-step narration. Return only the summary.'

const SYSTEM_MERGE =
  'Merge these partial summaries of a coding conversation into one coherent summary. ' +
  'Remove duplicates. Preserve: requirements, files changed, commands run, errors, ' +
  'decisions, and unfinished work. Be terse. Return only the merged summary.'

export interface CompactResult {
  history: Message[]
  compacted: boolean
  removedMessages: number
  usage?: Usage
  rateLimits?: RateLimits
}

export interface CompactBudgetEstimate {
  inputTokens: number
  maxOutputTokens: number
}

export async function compactHistory(options: {
  provider: Provider
  model: string
  history: Message[]
  maxTokens: number
  maxTotalOutputTokens?: number
  signal: AbortSignal
}): Promise<CompactResult> {
  const cut = compactCutIndex(options.history)
  if (cut <= 0) {
    return { history: options.history, compacted: false, removedMessages: 0 }
  }

  const oldMessages = options.history.slice(0, cut)
  const renderedMessages = renderMessages(oldMessages)
  const rendered = renderedMessages.join('\n\n')
  if (!rendered.trim()) {
    return { history: options.history, compacted: false, removedMessages: 0 }
  }

  let summary: string
  let usage: Usage | undefined
  let rateLimits: RateLimits | undefined

  if (rendered.length <= SINGLE_REQUEST_MAX_CHARS) {
    const requestMax = singleOutputLimit(options.maxTokens, options.maxTotalOutputTokens)
    const result = await summarizeText(
      options.provider,
      options.model,
      options.maxTokens,
      options.signal,
      rendered,
      SYSTEM_SUMMARIZE,
      requestMax,
    )
    summary = result.text
    usage = result.usage
    rateLimits = result.rateLimits
  } else {
    const chunks = chunkRenderedMessages(
      renderedMessages,
      CHUNK_TARGET_CHARS,
      CHUNK_OVERLAP_MESSAGES,
      CHUNK_OVERLAP_MAX_CHARS,
    )
    const limits = chunkOutputLimits(
      chunks.length,
      options.maxTokens,
      options.maxTotalOutputTokens,
    )
    const chunkResults = await summarizeSourcesParallel(
      options.provider,
      options.model,
      options.maxTokens,
      options.signal,
      chunks,
      SYSTEM_SUMMARIZE,
      limits.chunk,
    )
    const chunkUsages = chunkResults.map((result) => result.usage).filter(Boolean) as Usage[]
    usage = chunkUsages.length > 0 ? mergeUsage(chunkUsages) : undefined
    rateLimits = [...chunkResults].reverse().find((r) => r.rateLimits)?.rateLimits

    const mergeResult = await mergePartialSummaries(
      options.provider,
      options.model,
      options.maxTokens,
      options.signal,
      chunkResults.map((result) => result.text),
      limits.merge,
    )
    summary = mergeResult.text
    if (mergeResult.usage) {
      usage = usage ? mergeUsage([usage, mergeResult.usage]) : mergeResult.usage
    }
    if (mergeResult.rateLimits) rateLimits = mergeResult.rateLimits
  }

  summary = summary.trim()
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
  const estimate = estimateCompactBudget(history)
  return Math.max(1, estimate.inputTokens + estimate.maxOutputTokens)
}

export function estimateCompactBudget(
  history: Message[],
  maxTokens = MERGE_MAX_TOKENS,
): CompactBudgetEstimate {
  const cut = compactCutIndex(history)
  if (cut <= 0) return { inputTokens: 1, maxOutputTokens: 0 }
  const renderedMessages = renderMessages(history.slice(0, cut))
  const rendered = renderedMessages.join('\n\n')
  if (rendered.length <= SINGLE_REQUEST_MAX_CHARS) {
    return {
      inputTokens: Math.max(1, rendered.length + 1_000),
      maxOutputTokens: Math.max(1, Math.min(SINGLE_MAX_TOKENS, Math.floor(maxTokens))),
    }
  }
  const chunks = chunkRenderedMessages(
    renderedMessages,
    CHUNK_TARGET_CHARS,
    CHUNK_OVERLAP_MESSAGES,
    CHUNK_OVERLAP_MAX_CHARS,
  )
  const chunkInput = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const chunkOutput = Math.max(1, Math.min(CHUNK_MAX_TOKENS, Math.floor(maxTokens)))
  const mergeOutput = Math.max(1, Math.min(MERGE_MAX_TOKENS, Math.floor(maxTokens)))
  const mergeRequests = Math.max(0, chunks.length - 1)
  const totalOutput = chunks.length * chunkOutput + mergeRequests * mergeOutput
  // Every non-final summary can become input to a later merge. Eight chars per
  // output token is intentionally conservative for budget enforcement.
  const intermediateOutput =
    chunks.length * chunkOutput + Math.max(0, mergeRequests - 1) * mergeOutput
  const requestCount = chunks.length + mergeRequests
  return {
    inputTokens: Math.max(1, chunkInput + intermediateOutput * 8 + requestCount * 1_000),
    maxOutputTokens: totalOutput,
  }
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

/** Split already-rendered messages, so chunk decisions match the bytes sent. */
function chunkRenderedMessages(
  messages: string[],
  targetChars: number,
  overlapMessages: number,
  overlapMaxChars: number,
): string[] {
  const units = messages.flatMap((message) => splitLongMessage(message, targetChars))
  const chunks: string[] = []
  let current: string[] = []

  const sizeOf = (parts: string[]) => parts.reduce((total, part) => total + part.length, 0) +
    Math.max(0, parts.length - 1) * 2

  for (const unit of units) {
    if (current.length > 0 && sizeOf([...current, unit]) > targetChars) {
      chunks.push(current.join('\n\n'))
      const overlap: string[] = []
      let overlapChars = 0
      for (let index = current.length - 1; index >= 0 && overlap.length < overlapMessages; index -= 1) {
        const candidate = current[index] as string
        if (overlapChars + candidate.length > overlapMaxChars) break
        overlap.unshift(candidate)
        overlapChars += candidate.length
      }
      current = overlap
      while (current.length > 0 && sizeOf([...current, unit]) > targetChars) current.shift()
    }
    current.push(unit)
  }

  if (current.length > 0) chunks.push(current.join('\n\n'))
  return chunks
}

function splitLongMessage(message: string, targetChars: number): string[] {
  if (message.length <= targetChars) return [message]
  const parts: string[] = []
  let remaining = message
  const payloadLimit = Math.max(1, targetChars - 32)
  while (remaining.length > payloadLimit) {
    let cut = remaining.lastIndexOf('\n', payloadLimit)
    if (cut < payloadLimit * 0.6) cut = payloadLimit
    parts.push(`${remaining.slice(0, cut)}\n[message continues]`)
    remaining = `[continued message]\n${remaining.slice(cut).replace(/^\n/, '')}`
  }
  if (remaining) parts.push(remaining)
  return parts
}

interface SummarizeResult {
  text: string
  usage?: Usage
  rateLimits?: RateLimits
}

async function summarizeSourcesParallel(
  provider: Provider,
  model: string,
  maxTokens: number,
  signal: AbortSignal,
  sources: string[],
  systemPrompt: string,
  maxOutputTokens: number,
): Promise<SummarizeResult[]> {
  const results: SummarizeResult[] = new Array(sources.length)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  let next = 0

  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= sources.length) return
      try {
        results[index] = await summarizeText(
          provider,
          model,
          maxTokens,
          controller.signal,
          sources[index] as string,
          systemPrompt,
          maxOutputTokens,
        )
      } catch (error) {
        controller.abort(error)
        throw error
      }
    }
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_CONCURRENCY, sources.length) }, () => worker()),
    )
    return results
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function mergePartialSummaries(
  provider: Provider,
  model: string,
  maxTokens: number,
  signal: AbortSignal,
  summaries: string[],
  mergeMaxTokens: number,
): Promise<SummarizeResult> {
  let current = summaries
  const usages: Usage[] = []
  let rateLimits: RateLimits | undefined

  while (current.length > 1) {
    const groups = groupSummaries(current, MERGE_TARGET_CHARS)
    const sources = groups.map((group) =>
      group.map((summary, index) => `## Part ${index + 1}\n${summary}`).join('\n\n'),
    )
    const merged = await summarizeSourcesParallel(
      provider,
      model,
      maxTokens,
      signal,
      sources,
      SYSTEM_MERGE,
      mergeMaxTokens,
    )
    for (const result of merged) {
      if (!result.text) throw new Error('The provider returned an empty partial context summary.')
      if (result.usage) usages.push(result.usage)
      if (result.rateLimits) rateLimits = result.rateLimits
    }
    current = merged.map((result) => result.text)
  }

  return {
    text: current[0] ?? '',
    usage: usages.length > 0 ? mergeUsage(usages) : undefined,
    rateLimits,
  }
}

function singleOutputLimit(maxTokens: number, totalBudget?: number): number {
  const requested = Math.max(1, Math.min(SINGLE_MAX_TOKENS, Math.floor(maxTokens)))
  if (totalBudget === undefined) return requested
  const allowed = Math.floor(totalBudget)
  if (allowed < 1) throw new Error('The remaining turn budget is too small to compact context.')
  return Math.min(requested, allowed)
}

function chunkOutputLimits(
  chunkCount: number,
  maxTokens: number,
  totalBudget?: number,
): { chunk: number; merge: number } {
  let chunk = Math.max(1, Math.min(CHUNK_MAX_TOKENS, Math.floor(maxTokens)))
  let merge = Math.max(1, Math.min(MERGE_MAX_TOKENS, Math.floor(maxTokens)))
  if (totalBudget === undefined) return { chunk, merge }

  const mergeRequests = Math.max(0, chunkCount - 1)
  const requestCount = chunkCount + mergeRequests
  const allowed = Math.floor(totalBudget)
  if (allowed < requestCount) {
    throw new Error('The remaining turn budget is too small for all context-compaction requests.')
  }
  const requested = chunkCount * chunk + mergeRequests * merge
  if (allowed >= requested) return { chunk, merge }

  const scale = allowed / requested
  chunk = Math.max(1, Math.floor(chunk * scale))
  merge = Math.max(1, Math.floor(merge * scale))
  const total = () => chunkCount * chunk + mergeRequests * merge
  while (total() > allowed) {
    if (mergeRequests > 0 && merge > 1 && merge >= chunk) merge -= 1
    else if (chunk > 1) chunk -= 1
    else if (merge > 1) merge -= 1
    else throw new Error('Could not fit context compaction into the remaining turn budget.')
  }
  return { chunk, merge }
}

function groupSummaries(summaries: string[], targetChars: number): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let size = 0
  for (const summary of summaries) {
    if (current.length >= 2 && size + 12 + summary.length > targetChars) {
      groups.push(current)
      current = []
      size = 0
    }
    const separator = current.length > 0 ? 12 : 0
    current.push(summary)
    size += separator + summary.length
  }
  if (current.length > 0) groups.push(current)
  return groups
}

async function summarizeText(
  provider: Provider,
  model: string,
  maxTokens: number,
  signal: AbortSignal,
  source: string,
  systemPrompt: string,
  maxOutputTokens: number,
): Promise<SummarizeResult> {
  if (signal.aborted) throw signal.reason ?? new Error('Context compaction was cancelled.')
  let summary = ''
  let finalText = ''
  let usage: Usage | undefined
  let rateLimits: RateLimits | undefined

  const stream = provider.stream({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
    tools: [],
    maxTokens: Math.max(1, Math.floor(Math.min(maxOutputTokens, maxTokens))),
    thinking: false,
    signal,
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

  if (signal.aborted) throw signal.reason ?? new Error('Context compaction was cancelled.')

  return { text: (finalText || summary).trim(), usage, rateLimits }
}

function mergeUsage(usages: Usage[]): Usage {
  return usages.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      cacheRead: acc.cacheRead + u.cacheRead,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  )
}

function renderMessages(history: Message[]): string[] {
  return history.flatMap((message) => {
    const blocks = message.content.map((block) => renderBlock(block, message.role)).filter(Boolean)
    return blocks.length > 0 ? [`${message.role.toUpperCase()}:\n${blocks.join('\n')}`] : []
  })
}

function renderBlock(block: ContentBlock, role: Message['role']): string {
  switch (block.type) {
    case 'text':
      return truncate(
        block.text,
        role === 'user' ? MAX_USER_TEXT_CHARS : MAX_ASSISTANT_TEXT_CHARS,
      )
    case 'thinking':
      return ''
    case 'image':
      return `[image: ${block.name}]`
    case 'file':
      return `[file: ${block.name}]\n${truncate(block.text, MAX_FILE_BLOCK_CHARS)}`
    case 'tool_use':
      return `[tool: ${block.name}(${truncate(safeJson(block.input), MAX_TOOL_INPUT_CHARS)})]`
    case 'tool_result':
      if (block.isError) {
        return `[tool result error: ${truncate(block.content, MAX_TOOL_ERROR_CHARS)}]`
      }
      if (isTrivialSuccess(block.content)) return ''
      return truncate(block.content, MAX_TOOL_RESULT_CHARS)
  }
}

function isTrivialSuccess(content: string): boolean {
  const t = content.trim().toLowerCase()
  if (!t || t === 'ok' || t === 'done' || t === 'success') return true
  if (/^no matches found/.test(t)) return true
  if (t === '(no output)') return true
  return false
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  // Keep the end of the value — it's often more informative
  const keep = Math.floor(max * 0.4)
  return `${value.slice(0, max - keep)}\n...${value.slice(-keep)}`
}
