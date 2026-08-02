import type {
  ChatRequest,
  ContentBlock,
  Effort,
  Message,
  Provider,
  RefusalInfo,
  StopReason,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
  Usage,
} from '../providers/types'
import type { PermissionMode, Tool, ToolContext, ToolDisplay } from '../tools/types'
import type { AgentHooks } from './types'
import { sanitizeHistory } from './session'
import type { TurnBudget } from './budget'

const MAX_PAUSE_RESUMES = 5

export const MAX_TURN_STEPS = 64
export const MAX_TOOL_CALLS_PER_STEP = 32

export interface ToolLookup {
  get(name: string): Tool | undefined
  schemas(): ToolSchema[]
}

export interface PermissionGate {
  decide(tool: Tool, requested?: PermissionMode): PermissionMode
  grantForSession(name: string): void
  denyReason?(tool: Tool, requested?: PermissionMode): string | undefined
}

export interface UsageSink {
  record(modelRef: string, usage: Usage): void
}

export interface AgentConfig {
  provider: Provider
  modelId: string
  modelRef: string
  system: string
  tools: ToolLookup
  permissions: PermissionGate
  usage: UsageSink
  cwd: string
  maxTokens: number
  effort: Effort
  thinking: boolean
  budget?: TurnBudget
}

interface StreamOutcome {
  content: ContentBlock[]
  stopReason: StopReason
  refusal?: RefusalInfo
}

export async function runTurn(
  cfg: AgentConfig,
  history: Message[],
  hooks: AgentHooks,
  signal: AbortSignal,
): Promise<Message[]> {
  let messages = [...history]
  let pauses = 0
  let steps = 0

  for (;;) {
    if (++steps > MAX_TURN_STEPS) {
      hooks.onEvent({
        type: 'notice',
        level: 'warn',
        text: `Stopped after ${MAX_TURN_STEPS} model calls without finishing, to avoid burning tokens in a loop. Ask again with a narrower request.`,
      })
      hooks.onEvent({ type: 'turn_end', stopReason: 'max_tokens' })
      return messages
    }

    const budgetDecision = cfg.budget?.beforeRequest({
      modelRef: cfg.modelRef,
      maxOutputTokens: cfg.maxTokens,
      estimatedInputTokens: estimateRequestTokens(cfg, messages),
    })
    if (budgetDecision && !budgetDecision.allowed) {
      hooks.onEvent({ type: 'notice', level: 'warn', text: budgetDecision.reason })
      hooks.onEvent({ type: 'turn_end', stopReason: 'max_tokens' })
      return messages
    }

    hooks.onEvent({ type: 'turn_start' })
    const outcome = await consumeStream(
      cfg,
      messages,
      hooks,
      signal,
      budgetDecision?.maxOutputTokens ?? cfg.maxTokens,
    )
    messages.push({ role: 'assistant', content: outcome.content })

    if (outcome.stopReason === 'aborted') {
      hooks.onEvent({ type: 'turn_end', stopReason: 'aborted' })
      return sanitizeHistory(messages)
    }

    if (outcome.stopReason === 'tool_use') {
      const callCount = outcome.content.filter((block) => block.type === 'tool_use').length
      if (callCount > MAX_TOOL_CALLS_PER_STEP) {
        hooks.onEvent({
          type: 'notice',
          level: 'warn',
          text: `The model returned ${callCount} tool calls at once; the limit is ${MAX_TOOL_CALLS_PER_STEP}. None were run. Ask it to split the work into smaller batches.`,
        })
        hooks.onEvent({ type: 'turn_end', stopReason: 'max_tokens' })
        return sanitizeHistory(messages)
      }
      const results = await runToolCalls(cfg, outcome.content, hooks, signal)
      if (results.length > 0) messages.push({ role: 'user', content: results })
      if (signal.aborted) {
        hooks.onEvent({ type: 'turn_end', stopReason: 'aborted' })
        return sanitizeHistory(messages)
      }
      continue
    }

    if (outcome.stopReason === 'pause_turn') {
      pauses += 1
      if (pauses <= MAX_PAUSE_RESUMES) continue
      hooks.onEvent({
        type: 'notice',
        level: 'warn',
        text: `Server-side tool loop still paused after ${MAX_PAUSE_RESUMES} resumes; stopping.`,
      })
    }

    if (outcome.stopReason === 'refusal') {
      hooks.onEvent({ type: 'notice', level: 'warn', text: describeRefusal(outcome.refusal) })
    }

    if (outcome.stopReason === 'max_tokens') {
      hooks.onEvent({
        type: 'notice',
        level: 'warn',
        text: 'Output hit maxTokens and was cut off. Raise maxTokens in config or ask it to continue.',
      })
    }

    hooks.onEvent({ type: 'turn_end', stopReason: outcome.stopReason })
    return messages
  }
}

async function consumeStream(
  cfg: AgentConfig,
  messages: Message[],
  hooks: AgentHooks,
  signal: AbortSignal,
  maxTokens: number,
): Promise<StreamOutcome> {
  const request: ChatRequest = {
    model: cfg.modelId,
    system: cfg.system,
    messages,
    tools: cfg.tools.schemas(),
    maxTokens,
    effort: cfg.effort,
    thinking: cfg.thinking,
    signal,
  }

  let outcome: StreamOutcome | undefined

  for await (const event of cfg.provider.stream(request)) {
    switch (event.type) {
      case 'text_delta':
        hooks.onEvent({ type: 'text_delta', text: event.text })
        break
      case 'thinking_delta':
        hooks.onEvent({ type: 'thinking_delta', text: event.text })
        break
      case 'usage':
        cfg.budget?.record(cfg.modelRef, event.usage)
        cfg.usage.record(cfg.modelRef, event.usage)
        hooks.onEvent({ type: 'usage', model: cfg.modelRef, usage: event.usage })
        break
      case 'tool_call':
        break
      case 'done':
        outcome = { content: event.content, stopReason: event.stopReason, refusal: event.refusal }
        break
    }
  }

  if (outcome) return outcome
  if (signal.aborted) return { content: [], stopReason: 'aborted' }
  throw new Error(
    `"${cfg.provider.id}" ended the stream without completing the turn — nothing was generated. The endpoint answered, but not with a usable ${cfg.provider.kind} response.`,
  )
}

function estimateRequestTokens(cfg: AgentConfig, messages: Message[]): number {
  let characters = cfg.system.length
  try {
    characters += JSON.stringify(messages).length
    characters += JSON.stringify(cfg.tools.schemas()).length
  } catch {
    // Provider serialization will report malformed/cyclic data. Keep a small
    // non-zero estimate here so the budget still has a conservative floor.
    return Math.max(1, characters)
  }
  // One token per UTF-16 character deliberately overestimates ordinary code
  // and prose, reserving room for input before an API request is sent.
  return Math.max(1, characters)
}

async function runToolCalls(
  cfg: AgentConfig,
  content: ContentBlock[],
  hooks: AgentHooks,
  signal: AbortSignal,
): Promise<ToolResultBlock[]> {
  const calls = content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
  const results: ToolResultBlock[] = []
  for (const call of calls) {
    results.push(await runOneCall(cfg, call, hooks, signal))
  }
  return results
}

async function runOneCall(
  cfg: AgentConfig,
  call: ToolUseBlock,
  hooks: AgentHooks,
  signal: AbortSignal,
): Promise<ToolResultBlock> {
  const tool = cfg.tools.get(call.name)
  if (!tool) {
    return toolError(call.id, `Unknown tool "${call.name}". Use only the tools provided.`)
  }

  const summary = describeCall(tool, call.input)
  const ctx: ToolContext = {
    cwd: cfg.cwd,
    signal,
    requestPermission: (request) => hooks.requestPermission(request),
    confirm: async (question) =>
      (await hooks.requestPermission({
        toolName: tool.name,
        summary: question,
        input: call.input,
      })) !== 'deny',
  }

  const requestedPermission = requestedPermissionFor(tool, call.input, ctx)
  const gate = cfg.permissions.decide(tool, requestedPermission)
  if (gate === 'deny') {
    return toolError(
      call.id,
      cfg.permissions.denyReason?.(tool, requestedPermission) ??
        `Tool "${tool.name}" is disabled by the user's configuration. Do not retry it; find another way or ask.`,
    )
  }

  if (gate === 'ask') {
    const decision = await hooks.requestPermission({
      toolName: tool.name,
      summary,
      input: call.input,
      display: await previewCall(tool, call.input, ctx),
      allowAlways: canAlwaysApprove(tool),
    })
    if (decision === 'deny') {
      return toolError(call.id, 'The user declined this call. Do not retry it; ask how to proceed.')
    }
    if (decision === 'always') cfg.permissions.grantForSession(tool.name)
  }

  if (signal.aborted) {
    return toolError(call.id, 'Interrupted by the user before this tool ran.')
  }

  hooks.onEvent({ type: 'tool_start', id: call.id, name: tool.name, summary })

  try {
    const result = await tool.execute(call.input, ctx)
    hooks.onEvent({
      type: 'tool_end',
      id: call.id,
      isError: result.isError === true,
      content: result.content,
      display: result.display,
    })
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content: result.content,
      isError: result.isError,
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    hooks.onEvent({ type: 'tool_end', id: call.id, isError: true, content: text })
    return toolError(call.id, text)
  }
}

async function previewCall(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolDisplay | undefined> {
  const preview = tool.preview
  if (!preview) return undefined
  try {
    return await preview.call(tool, input, ctx)
  } catch {
    return undefined
  }
}

function canAlwaysApprove(tool: Tool): boolean {
  return tool.name !== 'bash' && tool.name !== 'task' && !tool.name.startsWith('mcp__')
}

function requestedPermissionFor(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): PermissionMode | undefined {
  try {
    return tool.permission?.(input, ctx)
  } catch {
    return undefined
  }
}

function describeCall(tool: Tool, input: unknown): string {
  try {
    return tool.summarize(input)
  } catch {
    return tool.name
  }
}

function describeRefusal(refusal: RefusalInfo | undefined): string {
  const parts = ['The model declined this request.']
  if (refusal?.category) parts.push(`Category: ${refusal.category}.`)
  if (refusal?.explanation) parts.push(refusal.explanation)
  return parts.join(' ')
}

function toolError(toolUseId: string, content: string): ToolResultBlock {
  return { type: 'tool_result', toolUseId, content, isError: true }
}
