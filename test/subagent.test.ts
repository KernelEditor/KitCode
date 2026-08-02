import { describe, expect, it } from 'vitest'
import type { AgentConfig, ToolLookup } from '../src/core/agent'
import {
  createSubagentRunner,
  MAX_SUBAGENT_STEPS,
  SUBAGENT_CANCELLED,
  SUBAGENT_NO_ANSWER,
} from '../src/core/subagent'
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types'
import { createTaskTool, MAX_SUBAGENTS_PER_TURN } from '../src/tools/task'
import { toToolSchema } from '../src/tools/types'
import type { Tool, ToolContext } from '../src/tools/types'

function scripted(turns: StreamEvent[][]): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  let turn = 0
  return {
    requests,
    provider: {
      id: 'stub',
      kind: 'openai',
      stream: async function* (req) {
        requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) })
        for (const event of turns[turn++] ?? []) yield event
      },
      listModels: async () => [],
      knownModels: () => [],
    },
  }
}

function looping(call: () => StreamEvent[]): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    requests,
    provider: {
      id: 'stub',
      kind: 'openai',
      stream: async function* (req) {
        requests.push(req)
        if (req.signal?.aborted) {
          yield { type: 'done', stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }] }
          return
        }
        for (const event of call()) yield event
      },
      listModels: async () => [],
      knownModels: () => [],
    },
  }
}

function callTurn(id: string, name: string, input: unknown, chatter?: string): StreamEvent[] {
  const events: StreamEvent[] = chatter ? [{ type: 'text_delta', text: chatter }] : []
  events.push({ type: 'done', stopReason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] })
  return events
}

function answerTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text }] },
  ]
}

function fakeRead(calls: string[]): Tool {
  return {
    name: 'read',
    description: 'read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    defaultPermission: 'allow',
    summarize: (input) => `read(${(input as { path: string }).path})`,
    execute: async (input) => {
      calls.push((input as { path: string }).path)
      return { content: 'export function foo() {}' }
    },
  }
}

function lookupOf(tools: Tool[]): ToolLookup {
  return {
    get: (name) => tools.find((tool) => tool.name === name),
    schemas: () => tools.map(toToolSchema),
  }
}

function makeConfigWith(provider: Provider, override?: ToolLookup) {
  return (system: string, tools: ToolLookup): AgentConfig => ({
    provider,
    modelId: 'test-model',
    modelRef: 'stub/test-model',
    system,
    tools: override ?? tools,
    permissions: { decide: () => 'allow', grantForSession: () => {} },
    usage: { record: () => {} },
    cwd: '/tmp/kitcode-subagent',
    maxTokens: 256,
    effort: 'medium',
    thinking: false,
  })
}

function context(signal: AbortSignal): ToolContext {
  return { cwd: '/tmp/kitcode-subagent', signal, confirm: async () => true }
}

function taskWithParent(provider: Provider, extra: Tool[] = []): { task: Tool; parent: ToolLookup } {
  const parentTools: Tool[] = [...extra]
  const parent = lookupOf(parentTools)
  const task = createTaskTool(createSubagentRunner(makeConfigWith(provider, parent), parent))
  parentTools.push(task)
  return { task, parent }
}

describe('subagent runner', () => {
  it('returns the final assistant text after the subagent uses a tool', async () => {
    const calls: string[] = []
    const { provider, requests } = scripted([
      callTurn('c1', 'read', { path: 'src/a.ts' }),
      answerTurn('foo is defined in src/a.ts:1.'),
    ])
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([fakeRead(calls)]))

    const answer = await runner.run({
      prompt: 'where is foo defined?',
      signal: new AbortController().signal,
      onProgress: () => {},
    })

    expect(answer).toBe('foo is defined in src/a.ts:1.')
    expect(calls).toEqual(['src/a.ts'])
    expect(requests[0].messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'where is foo defined?' }] },
    ])
    expect(requests[0].system).toContain('final message')
    expect(requests[0].system).toContain('/tmp/kitcode-subagent')
  })

  it('never exposes the task tool to the subagent, even when the config builder ignores the isolated set', async () => {
    const calls: string[] = []
    const { provider, requests } = scripted([
      callTurn('c1', 'task', { description: 'go deeper', prompt: 'delegate again' }),
      callTurn('c2', 'task', { description: 'try again', prompt: 'delegate again' }),
      answerTurn('Could not delegate; answered directly.'),
    ])
    const { task, parent } = taskWithParent(provider, [fakeRead(calls)])

    const result = await task.execute(
      { description: 'find callers', prompt: 'find every caller of foo' },
      context(new AbortController().signal),
    )

    expect(parent.get('task')).toBeDefined()
    expect(parent.schemas().map((schema) => schema.name)).toContain('task')
    expect(requests.map((request) => request.tools.map((schema) => schema.name))).toEqual([
      ['read'],
      ['read'],
      ['read'],
    ])
    expect(requests).toHaveLength(3)
    for (const request of requests.slice(1)) {
      expect(request.messages.at(-1)?.content).toEqual([
        {
          type: 'tool_result',
          toolUseId: expect.any(String),
          content: 'Unknown tool "task". Use only the tools provided.',
          isError: true,
        },
      ])
    }
    expect(result.content).toBe('Could not delegate; answered directly.')
    expect(result.isError).toBeFalsy()
  })

  it('explains an empty final answer instead of returning an empty string', async () => {
    const { provider } = scripted([[{ type: 'done', stopReason: 'end_turn', content: [] }]])
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([]))

    const answer = await runner.run({
      prompt: 'say nothing',
      signal: new AbortController().signal,
      onProgress: () => {},
    })

    expect(answer).not.toBe('')
    expect(answer).toBe(SUBAGENT_NO_ANSWER)
  })

  it('stops when the parent signal aborts and does not hang', async () => {
    let received: AbortSignal | undefined
    const provider: Provider = {
      id: 'stub',
      kind: 'openai',
      stream: async function* (req) {
        received = req.signal
        yield { type: 'text_delta', text: 'working' }
        await new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve()
          else req.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'done', stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }] }
      },
      listModels: async () => [],
      knownModels: () => [],
    }
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([]))
    const controller = new AbortController()

    const pending = runner.run({
      prompt: 'long search',
      signal: controller.signal,
      onProgress: () => {},
    })
    controller.abort()

    await expect(pending).resolves.toBe('partial')
    expect(received?.aborted).toBe(true)
  }, 2_000)

  it('does not call the provider at all when the parent has already aborted', async () => {
    const { provider, requests } = scripted([answerTurn('should never run')])
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([]))
    const controller = new AbortController()
    controller.abort()

    const answer = await runner.run({
      prompt: 'too late',
      signal: controller.signal,
      onProgress: () => {},
    })

    expect(requests).toHaveLength(0)
    expect(answer).toBe(SUBAGENT_CANCELLED)
  }, 2_000)

  it('caps a runaway tool loop instead of calling the model forever', async () => {
    let id = 0
    const calls: string[] = []
    const { provider, requests } = looping(() => callTurn(`c${++id}`, 'read', { path: 'src/a.ts' }))
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([fakeRead(calls)]))

    const answer = await runner.run({
      prompt: 'loop forever',
      signal: new AbortController().signal,
      onProgress: () => {},
    })

    expect(requests.length).toBeLessThanOrEqual(MAX_SUBAGENT_STEPS + 1)
    expect(answer).toContain(`stopped after ${MAX_SUBAGENT_STEPS} model calls`)
  }, 5_000)

  it('reports tool starts through onProgress and keeps the subagent text out of it', async () => {
    const calls: string[] = []
    const { provider } = scripted([
      callTurn('c1', 'read', { path: 'src/a.ts' }, 'First I will scan the repository for foo.'),
      answerTurn('foo is defined in src/a.ts:1.'),
    ])
    const runner = createSubagentRunner(makeConfigWith(provider), lookupOf([fakeRead(calls)]))
    const progress: string[] = []

    const answer = await runner.run({
      prompt: 'where is foo defined?',
      signal: new AbortController().signal,
      onProgress: (line) => progress.push(line),
    })

    expect(progress).toEqual(['read(src/a.ts)'])
    expect(progress.join('\n')).not.toContain('scan the repository')
    expect(progress.join('\n')).not.toContain(answer)
  })
})

describe('task tool', () => {
  it('surfaces a failing subagent as an error result instead of throwing', async () => {
    const provider: Provider = {
      id: 'stub',
      kind: 'openai',
      stream: async function* () {
        throw new Error('provider exploded')
      },
      listModels: async () => [],
      knownModels: () => [],
    }
    const task = createTaskTool(createSubagentRunner(makeConfigWith(provider), lookupOf([])))

    const result = await task.execute(
      { description: 'find callers', prompt: 'find every caller of foo' },
      context(new AbortController().signal),
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('provider exploded')
  })

  it('rejects malformed input without throwing', async () => {
    const { provider, requests } = scripted([answerTurn('never')])
    const task = createTaskTool(createSubagentRunner(makeConfigWith(provider), lookupOf([])))

    for (const input of [null, {}, { description: 'x', prompt: '   ' }]) {
      const result = await task.execute(input, context(new AbortController().signal))
      expect(result.isError).toBe(true)
    }
    expect(task.summarize(null)).toBe('task()')
    expect(requests).toHaveLength(0)
  })

  it('caps how many subagents one parent turn can spawn', async () => {
    const { provider } = looping(() => answerTurn('done'))
    const task = createTaskTool(createSubagentRunner(makeConfigWith(provider), lookupOf([])))
    const turn = new AbortController()

    const results = []
    for (let i = 0; i <= MAX_SUBAGENTS_PER_TURN; i++) {
      results.push(await task.execute({ description: 'work', prompt: 'do it' }, context(turn.signal)))
    }

    expect(results.slice(0, MAX_SUBAGENTS_PER_TURN).every((r) => !r.isError)).toBe(true)
    expect(results[MAX_SUBAGENTS_PER_TURN].isError).toBe(true)
    expect(results[MAX_SUBAGENTS_PER_TURN].content).toContain('limit')

    const fresh = await task.execute(
      { description: 'work', prompt: 'do it' },
      context(new AbortController().signal),
    )
    expect(fresh.isError).toBeFalsy()
  })

  it('summarizes with the description', () => {
    const { provider } = scripted([])
    const task = createTaskTool(createSubagentRunner(makeConfigWith(provider), lookupOf([])))
    expect(task.summarize({ description: 'find all callers of foo', prompt: 'x' })).toBe(
      'task(find all callers of foo)',
    )
    expect(task.defaultPermission).toBe('allow')
  })
})
