import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

const MAX_JOBS = 8
const MAX_JOB_OUTPUT = 100_000

export type JobState = 'running' | 'exited' | 'killed'

export interface JobSummary {
  id: string
  command: string
  state: JobState
  exitCode: number | null
  signal: string | null
}

export interface JobRead extends JobSummary {
  output: string
  truncated: boolean
}

interface Job extends JobSummary {
  child: ChildProcess
  buffer: string
  reported: number
  truncated: boolean
}

const jobs = new Map<string, Job>()
let counter = 0

export function startJob(command: string, cwd: string): { id: string } | { error: string } {
  const live = [...jobs.values()].filter((job) => job.state === 'running')
  if (live.length >= MAX_JOBS) {
    return { error: `At most ${MAX_JOBS} background commands can run at once.` }
  }

  counter += 1
  const id = `bg-${counter}`
  const child = spawn(command, {
    shell: true,
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const job: Job = {
    id,
    command,
    state: 'running',
    exitCode: null,
    signal: null,
    child,
    buffer: '',
    reported: 0,
    truncated: false,
  }
  jobs.set(id, job)

  const collect = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    const room = MAX_JOB_OUTPUT - job.buffer.length
    if (text.length <= room) {
      job.buffer += text
      return
    }
    // Keep the newest output: a watcher left running all session would
    // otherwise freeze on the first screenful and hide its latest errors.
    job.truncated = true
    job.buffer = (job.buffer + text).slice(-MAX_JOB_OUTPUT)
    job.reported = Math.min(job.reported, job.buffer.length)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  child.on('error', (error) => {
    job.buffer += `\nCommand failed to start: ${error.message}`
    job.state = 'exited'
    job.exitCode = job.exitCode ?? 1
  })
  child.on('close', (code, signal) => {
    if (job.state !== 'killed') job.state = 'exited'
    job.exitCode = code
    job.signal = signal
  })

  return { id }
}

// Output already handed to the model is not repeated: each read returns only
// what arrived since the previous one, so polling a chatty job stays cheap.
export function readJob(id: string): JobRead | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  const output = job.buffer.slice(job.reported)
  job.reported = job.buffer.length
  return { ...summary(job), output, truncated: job.truncated }
}

export function killJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  if (job.state === 'running') {
    job.state = 'killed'
    killTree(job.child)
  }
  return true
}

export function listJobs(): JobSummary[] {
  return [...jobs.values()].map(summary)
}

export function killAllJobs(): void {
  for (const job of jobs.values()) {
    if (job.state === 'running') {
      job.state = 'killed'
      killTree(job.child)
    }
  }
}

export function resetJobs(): void {
  killAllJobs()
  jobs.clear()
  counter = 0
}

function summary(job: Job): JobSummary {
  return {
    id: job.id,
    command: job.command,
    state: job.state,
    exitCode: job.exitCode,
    signal: job.signal,
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid == null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
