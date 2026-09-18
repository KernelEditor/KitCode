import { killJob, listJobs, readJob } from './jobs'
import type { Tool, ToolResult } from './types'

interface BashOutputInput {
  id?: string
  kill?: boolean
}

export const bashOutputTool: Tool = {
  name: 'bash_output',
  description:
    'Collect output from commands started with bash({ background: true }). Returns only the output that arrived since the last read. Omit id to list every background command. Set kill to stop one.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background command id, e.g. "bg-1"' },
      kill: { type: 'boolean', description: 'Stop the command instead of reading it' },
    },
    additionalProperties: false,
  },
  defaultPermission: 'allow',
  readOnly: true,
  summarize(input) {
    const { id, kill } = input as BashOutputInput
    if (!id) return 'bash_output(list)'
    return kill ? `bash_output(${id}, kill)` : `bash_output(${id})`
  },
  execute(input) {
    const { id, kill } = input as BashOutputInput

    if (!id) {
      const jobs = listJobs()
      if (jobs.length === 0) return done({ content: 'No background commands have been started.' })
      const lines = jobs.map((job) => `${job.id}  ${describeState(job.state, job.exitCode, job.signal)}  ${job.command}`)
      return done({ content: lines.join('\n') })
    }

    if (kill) {
      const stopped = killJob(id)
      return done(
        stopped
          ? { content: `[${id} stopped]` }
          : { content: `No background command with id "${id}".`, isError: true },
      )
    }

    const job = readJob(id)
    if (!job) return done({ content: `No background command with id "${id}".`, isError: true })

    const notes = [`[${id} ${describeState(job.state, job.exitCode, job.signal)}]`]
    if (job.truncated) notes.push('[output buffer full; earlier output was dropped]')
    const body = job.output.trim() === '' ? '(no new output)' : job.output.replace(/\n+$/, '')
    return done({
      content: [body, ...notes].join('\n'),
      isError: job.state === 'exited' && job.exitCode !== null && job.exitCode !== 0,
    })
  },
}

function describeState(state: string, exitCode: number | null, signal: string | null): string {
  if (state === 'running') return 'still running'
  if (state === 'killed') return `stopped${signal ? ` by ${signal}` : ''}`
  return exitCode === 0 ? 'finished' : `exit code ${exitCode}`
}

function done(result: ToolResult): Promise<ToolResult> {
  return Promise.resolve(result)
}
