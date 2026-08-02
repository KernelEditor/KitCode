import { TASK_TOOL_NAME } from '../core/subagent'
import type { SubagentRunner } from '../core/subagent'
import { brief } from './summary'
import type { Tool, ToolResult } from './types'

const MAX_PROGRESS_LINES = 10

export const MAX_SUBAGENTS_PER_TURN = 8

const DESCRIPTION = [
  'Hand one self-contained sub-task to a subagent that works in its own fresh context and reports back a single summary.',
  'Use it when the task is genuinely independent and its intermediate output would be long or noisy: a wide search across the repository, reading many files to answer one question, tracing where something is used.',
  'Do not use it for work that is a couple of tool calls, and do not use it when you already have what you need — call the tools yourself instead.',
  'The subagent shares this filesystem and working directory but has NO memory of this conversation and cannot ask you anything, so "prompt" must stand alone: the goal, the constraints, and exactly what to report back.',
  'It runs to completion and you receive only its final message.',
].join(' ')

export function createTaskTool(runner: SubagentRunner): Tool {
  const spawnsPerTurn = new WeakMap<AbortSignal, number>()

  return {
    name: TASK_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-6 word label for this task' },
        prompt: { type: 'string', description: 'Self-contained instruction for the subagent' },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
    defaultPermission: 'allow',
    summarize(input) {
      return `task(${brief(field(input, 'description'))})`
    },
    async execute(input, ctx): Promise<ToolResult> {
      const instruction = field(input, 'prompt').trim()
      if (instruction === '') {
        return { content: 'task needs a prompt: the full instruction for the subagent.', isError: true }
      }

      const spawned = (spawnsPerTurn.get(ctx.signal) ?? 0) + 1
      spawnsPerTurn.set(ctx.signal, spawned)
      if (spawned > MAX_SUBAGENTS_PER_TURN) {
        return {
          content: `Already delegated ${MAX_SUBAGENTS_PER_TURN} subagents while answering this message, which is the limit. Do the remaining work yourself with the tools you have.`,
          isError: true,
        }
      }

      const progress: string[] = []
      try {
        const content = await runner.run({
          prompt: instruction,
          signal: ctx.signal,
          onProgress: (line) => progress.push(line),
          confirm: ctx.confirm,
          requestPermission: ctx.requestPermission,
        })
        if (progress.length === 0) return { content }
        return {
          content,
          display: {
            kind: 'list',
            title: `task ${brief(field(input, 'description'), 40)}`,
            items: progress.slice(-MAX_PROGRESS_LINES),
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { content: `The subagent failed: ${reason}`, isError: true }
      }
    },
  }
}

function field(input: unknown, key: 'description' | 'prompt'): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}
