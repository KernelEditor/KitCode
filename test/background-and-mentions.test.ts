import { describe, expect, it, afterEach } from 'vitest'
import { bashTool } from '../src/tools/bash'
import { bashOutputTool } from '../src/tools/bash-output'
import { listJobs, resetJobs } from '../src/tools/jobs'
import { completeMention, extractMentions, mentionSpan } from '../src/ui/mentions'
import type { ToolContext } from '../src/tools/types'

const ctx: ToolContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  confirm: async () => true,
}

async function settle(id: string, tries = 80): Promise<string> {
  let seen = ''
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = await bashOutputTool.execute({ id }, ctx)
    seen += result.content
    if (!result.content.includes('still running')) return seen
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`job ${id} never finished`)
}

describe('background commands', () => {
  afterEach(() => {
    resetJobs()
  })

  it('returns before the command finishes and collects its output later', async () => {
    const started = await bashTool.execute(
      { command: `"${process.execPath}" -e "console.log('worked')"`, background: true },
      ctx,
    )
    const id = /bg-\d+/.exec(started.content)?.[0]
    expect(id).toBeDefined()
    expect(started.isError).toBeUndefined()
    expect(listJobs()).toHaveLength(1)

    const output = await settle(id!)
    expect(output).toContain('worked')
    expect(output).toContain('finished')
  })

  it('hands out only the output that arrived since the previous read', async () => {
    const started = await bashTool.execute(
      { command: `"${process.execPath}" -e "console.log('once')"`, background: true },
      ctx,
    )
    const id = /bg-\d+/.exec(started.content)![0]
    await settle(id)
    const second = await bashOutputTool.execute({ id }, ctx)
    expect(second.content).toContain('(no new output)')
  })

  it('reports a non-zero exit and can stop a running command', async () => {
    const failing = await bashTool.execute(
      { command: `"${process.execPath}" -e "process.exit(3)"`, background: true },
      ctx,
    )
    const failedId = /bg-\d+/.exec(failing.content)![0]
    expect(await settle(failedId)).toContain('exit code 3')

    const sleeping = await bashTool.execute(
      { command: `"${process.execPath}" -e "setTimeout(()=>{},60000)"`, background: true },
      ctx,
    )
    const sleepingId = /bg-\d+/.exec(sleeping.content)![0]
    const killed = await bashOutputTool.execute({ id: sleepingId, kill: true }, ctx)
    expect(killed.content).toContain('stopped')
    expect(listJobs().find((job) => job.id === sleepingId)?.state).toBe('killed')
  })

  it('explains an unknown id instead of inventing a job', async () => {
    const missing = await bashOutputTool.execute({ id: 'bg-404' }, ctx)
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('bg-404')
  })
})

describe('@ mentions', () => {
  it('recognizes the mention under the cursor only when @ opens a word', () => {
    expect(mentionSpan('look at @src/ui', 15)).toEqual({ start: 8, end: 15, query: 'src/ui' })
    expect(mentionSpan('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionSpan('mail me@example.com', 19)).toBeNull()
    expect(mentionSpan('no mention here', 15)).toBeNull()
  })

  it('keeps the tail of the line when completing, without doubling the space', () => {
    const span = mentionSpan('read @src and stop', 9)!
    expect(completeMention('read @src and stop', span, 'src/index.ts')).toEqual({
      value: 'read @src/index.ts and stop',
      cursor: 19,
    })

    const atEnd = mentionSpan('read @src', 9)!
    expect(completeMention('read @src', atEnd, 'src/index.ts')).toEqual({
      value: 'read @src/index.ts ',
      cursor: 19,
    })
  })

  it('pulls every distinct path out of a sent message', () => {
    expect(extractMentions('compare @a/b.ts and @c/d.ts, then @a/b.ts again')).toEqual([
      'a/b.ts',
      'c/d.ts',
    ])
    expect(extractMentions('no paths at all')).toEqual([])
  })
})
