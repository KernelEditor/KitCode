import type { Message } from '../providers/types'
import { brief } from '../tools/summary'
import type { AgentConfig, ToolLookup } from './agent'
import { runTurn } from './agent'
import type { AgentHooks, PermissionDecision, PermissionRequest } from './types'

export const TASK_TOOL_NAME = 'task'

export const MAX_SUBAGENT_STEPS = 12

export const SUBAGENT_NO_ANSWER =
  'The subagent stopped without writing a final answer — it was interrupted or ended on a tool call. Nothing was reported back: do the work directly, or delegate it again with a narrower prompt.'

export const SUBAGENT_CANCELLED = 'The subagent was cancelled before it produced anything.'

const STEP_LIMIT_NOTE = `The subagent was stopped after ${MAX_SUBAGENT_STEPS} model calls without finishing, so anything above is partial. Do the work directly or delegate a narrower piece of it.`

const SUBAGENT_SYSTEM = [
  'You are a subagent launched by the main kitcode agent to carry out one task on your own.',
  '',
  'Nobody is reading along and nobody can answer you. Never ask a question, never stop to propose a plan, never wait for approval. If the request is ambiguous, take the most reasonable reading, do the work, and state the assumption in your answer.',
  '',
  'Your final message is the return value — it is the only thing the caller ever sees. End with the answer itself: the findings, the file paths, the conclusion. Never end with "I will now..." or a recap of the steps you took. Carry over every concrete detail the caller needs (paths, names, line numbers) and leave out the narration of how you found them.',
].join('\n')

export interface SubagentRequest {
  prompt: string
  signal: AbortSignal
  onProgress(summary: string): void
  confirm?(question: string): Promise<boolean>
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>
}

export interface SubagentRunner {
  run(request: SubagentRequest): Promise<string>
}

export function createSubagentRunner(
  makeConfig: (system: string, tools: ToolLookup) => AgentConfig,
  tools: ToolLookup,
): SubagentRunner {
  return {
    async run(request) {
      if (request.signal.aborted) return SUBAGENT_CANCELLED

      const base = makeConfig(SUBAGENT_SYSTEM, tools)
      const cfg: AgentConfig = {
        ...base,
        tools: {
          get: (name) =>
            name === TASK_TOOL_NAME ? undefined : base.tools.get(name),
          schemas: () =>
            base.tools.schemas().filter((schema) => schema.name !== TASK_TOOL_NAME),
        },
        system: `${SUBAGENT_SYSTEM}\n\nWorking directory: ${base.cwd}`,
      }

      const limit = new AbortController()
      const signal = AbortSignal.any([request.signal, limit.signal])
      let steps = 0

      const hooks: AgentHooks = {
        onEvent(event) {
          if (event.type === 'turn_start' && ++steps > MAX_SUBAGENT_STEPS) limit.abort()
          if (event.type === 'tool_start') request.onProgress(brief(event.summary, 80))
        },
        async requestPermission(permission) {
          if (request.requestPermission) {
            return request.requestPermission({
              ...permission,
              summary: `subagent · ${permission.summary}`,
            })
          }
          const allowed = await request.confirm?.(`subagent · ${permission.summary}`)
          return allowed === true ? 'once' : 'deny'
        },
      }

      const history: Message[] = [
        { role: 'user', content: [{ type: 'text', text: request.prompt }] },
      ]
      const text = finalText(await runTurn(cfg, history, hooks, signal))

      if (!limit.signal.aborted) return text
      return text === SUBAGENT_NO_ANSWER ? STEP_LIMIT_NOTE : `${text}\n\n${STEP_LIMIT_NOTE}`
    },
  }
}

function finalText(messages: Message[]): string {
  const last = messages.findLast((message) => message.role === 'assistant')
  const text = (last?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text === '' ? SUBAGENT_NO_ANSWER : text
}
