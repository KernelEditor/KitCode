import type { SubagentStatus } from '../core/types'
import { randomBytes } from 'node:crypto'
import { TASK_TOOL_NAME } from '../core/subagent'
import type { SubagentRunner } from '../core/subagent'
import { brief } from './summary'
import type { Tool, ToolResult } from './types'

const MAX_PROGRESS_LINES = 10

const DESCRIPTION = [
  'Hand one self-contained sub-task to a subagent that works in its own fresh context and reports back a single summary.',
  'Use it when the task is genuinely independent and its intermediate output would be long or noisy: a wide search across the repository, reading many files to answer one question, tracing where something is used.',
  'Do not use it for work that is a couple of tool calls, and do not use it when you already have what you need — call the tools yourself instead.',
  'The subagent shares this filesystem and working directory but has NO memory of this conversation and cannot ask you anything, so "prompt" must stand alone: the goal, the constraints, and exactly what to report back.',
  'For multiple independent tasks, issue consecutive task calls in the same response so they can run concurrently. Do not delegate overlapping file edits.',
  'It runs to completion and you receive only its final message.',
].join(' ')

export function createTaskTool(runner: SubagentRunner): Tool {
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
    // Starting a subagent changes nothing by itself: each tool call it makes
    // goes through the same permission and plan-mode checks as the parent.
    defaultPermission: 'allow',
    readOnly: true,
    summarize(input) {
      return `task(${brief(field(input, 'description'))})`
    },
    async execute(input, ctx): Promise<ToolResult> {
      const instruction = field(input, 'prompt').trim()
      if (instruction === '') {
        return { content: 'task needs a prompt: the full instruction for the subagent.', isError: true }
      }

      const progress: string[] = []
      const subagentId = `sa${randomBytes(4).toString('hex')}`
      const description = field(input, 'description') || 'subagent'
      ctx.onEvent?.({ type: 'subagent_start', id: subagentId, description })
      let status: SubagentStatus = 'done'
      let reason: string | undefined
      try {
        let content = await runner.run({
          onComplete: (outcome, detail) => { status = outcome; reason = detail },
          prompt: instruction,
          description,
          signal: ctx.signal,
          onProgress: (line) => progress.push(line),
          onEvent: (event) => ctx.onEvent?.({ type: 'subagent_event', id: subagentId, event }),
          confirm: ctx.confirm,
          requestPermission: ctx.requestPermission,
        })
        if (ctx.signal.aborted) {
          status = 'cancelled'
          reason = 'Cancelled by the user; any output is partial.'
        }
        if (status !== 'done' && reason) content = `${reason}\n\n${content}`
        ctx.onEvent?.({ type: 'subagent_end', id: subagentId, result: content, status, reason })
        const isError = status !== 'done'
        if (progress.length === 0) return { content, isError }
        return {
          content,
          isError,
          display: {
            kind: 'list',
            title: `task ${brief(field(input, 'description'), 40)}`,
            items: progress.slice(-MAX_PROGRESS_LINES),
          },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const cancelled = ctx.signal.aborted
        const content = cancelled ? `The subagent was cancelled: ${reason}` : `The subagent failed: ${reason}`
        ctx.onEvent?.({ type: 'subagent_end', id: subagentId, result: content, status: cancelled ? 'cancelled' : 'error', reason })
        return { content, isError: true }
      }
    },
  }
}

function field(input: unknown, key: 'description' | 'prompt'): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}
