import { spawn } from 'node:child_process'
import { brief } from './summary'
import type { Tool, ToolResult } from './types'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 100_000

interface BashInput {
  command: string
  timeoutMs?: number
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace root. stdout and stderr are merged. Avoid commands that wait for interactive input.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run' },
      timeoutMs: {
        type: 'integer',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT})`,
        minimum: 1,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  defaultPermission: 'ask',
  summarize(input) {
    return `bash(${brief((input as BashInput).command)})`
  },
  execute(input, ctx) {
    const { command, timeoutMs } = input as BashInput
    const requested = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT
    const timeout = Math.min(requested, MAX_TIMEOUT)
    if (ctx.signal.aborted) {
      return Promise.resolve<ToolResult>({ content: '[cancelled before the command started]', isError: true })
    }

    return new Promise<ToolResult>((settle) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const chunks: string[] = []
      let captured = 0
      let truncated = false
      const collect = (text: string) => {
        if (truncated) return
        const room = MAX_OUTPUT - captured
        if (text.length > room) {
          chunks.push(text.slice(0, room))
          truncated = true
          return
        }
        chunks.push(text)
        captured += text.length
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      const killTree = () => {
        if (child.pid == null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }

      let timedOut = false
      let aborted = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree()
      }, timeout)
      const onAbort = () => {
        aborted = true
        killTree()
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (result: ToolResult) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        settle(result)
      }

      child.on('error', (error) => {
        finish({ content: `Command failed to start: ${error.message}`, isError: true })
      })

      child.on('close', (code, signal) => {
        const output = chunks.join('')
        const notes: string[] = []
        if (truncated) notes.push(`[output truncated at ${MAX_OUTPUT} characters]`)
        if (aborted) notes.push('[command was cancelled]')
        else if (timedOut) notes.push(`[command timed out after ${timeout}ms]`)
        if (code !== 0) notes.push(`[exit ${signal ? `signal ${signal}` : `code ${code}`}]`)
        const body = output.trim() === '' ? '(no output)' : output.replace(/\n+$/, '')
        finish({ content: [body, ...notes].join('\n'), isError: aborted || timedOut || code !== 0 })
      })
    })
  },
}
