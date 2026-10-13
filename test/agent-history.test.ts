import { describe, expect, it, vi } from 'vitest'
import { runTurn } from '../src/core/agent'
import type { AgentConfig } from '../src/core/agent'
import type { ContentBlock, Provider, StopReason } from '../src/providers/types'
import { INVALID_ARGUMENTS_KEY } from '../src/providers/types'
import type { Tool } from '../src/tools/types'

function scripted(replies: { stopReason: StopReason; content: ContentBlock[] }[]): Provider {
  let call = 0
  return {
    id: 'p',
    kind: 'openai',
    listModels: async () => [],
    knownModels: () => [],
    async *stream() {
      const reply = replies[call++] ?? { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
      yield { type: 'done', ...reply }
    },
  }
}

function config(provider: Provider, tool?: Tool): AgentConfig {
  return {
    provider,
    modelId: 'm',
    modelRef: 'p/m',
    system: '',
    tools: { get: (name) => (tool && name === tool.name ? tool : undefined), schemas: () => [] },
    permissions: { decide: () => 'allow', grantForSession() {} },
    usage: { record() {} },
    cwd: '.',
    maxTokens: 100,
    effort: 'auto',
    thinking: false,
  }
}

const hooks = { onEvent() {}, requestPermission: async () => 'deny' as const }
const user = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }]

describe('turn history', () => {
  it('never ends on a tool call that did not run', async () => {
    const provider = scripted([
      { stopReason: 'max_tokens', content: [{ type: 'text', text: 'I will read' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }] },
    ])
    const history = await runTurn(config(provider), user, hooks, new AbortController().signal)
    expect(history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'I will read' }] })
  })

  it('answers unparseable tool arguments with an error instead of running the tool', async () => {
    const execute = vi.fn(async () => ({ content: 'ran' }))
    const tool = { name: 'write', description: '', inputSchema: {}, defaultPermission: 'allow', summarize: () => 'write', execute } as unknown as Tool
    const provider = scripted([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'write', input: { [INVALID_ARGUMENTS_KEY]: '{"path":' } }] },
    ])
    const history = await runTurn(config(provider, tool), user, hooks, new AbortController().signal)
    expect(execute).not.toHaveBeenCalled()
    expect(history[2]?.content[0]).toMatchObject({ type: 'tool_result', isError: true, content: expect.stringContaining('not valid JSON') })
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
  })
})

describe('turn budget estimate', () => {
  it('passes the budget an input estimate in tokens, not characters', async () => {
    const seen: number[] = []
    const budget = {
      hasLimits: true,
      beforeRequest(request: { estimatedInputTokens: number; maxOutputTokens: number }) {
        seen.push(request.estimatedInputTokens)
        return { allowed: true as const, maxOutputTokens: request.maxOutputTokens }
      },
      record() {},
      snapshot: () => ({ tokens: 0, costUsd: 0 }),
    }
    const text = 'x'.repeat(40_000)
    const cfg = { ...config(scripted([{ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }])), budget }
    await runTurn(cfg, [{ role: 'user', content: [{ type: 'text', text }] }], hooks, new AbortController().signal)
    // ~40k characters of prompt are ~10k tokens; the old estimate said 40k.
    expect(seen[0]).toBeGreaterThan(10_000)
    expect(seen[0]).toBeLessThan(11_000)
  })
})
