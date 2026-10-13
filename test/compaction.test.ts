import { describe, expect, it } from 'vitest'
import {
  KEEP_RECENT_TOOL_RESULTS,
  clearOldToolResults,
  compactHistory,
  estimateHistoryTokens,
  withoutThinkingReplay,
} from '../src/core/compact'
import { runTurn } from '../src/core/agent'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/providers/types'

const bigOutput = (index: number) => `output ${index}\n${'x'.repeat(2_000)}`

function agenticTurn(calls: number): Message[] {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'fix the build' }] }]
  for (let index = 0; index < calls; index += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${index}`, name: 'read', input: { path: `f${index}` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${index}`, content: bigOutput(index) }] })
  }
  return messages
}

describe('clearing old tool output', () => {
  it('keeps the most recent results and replaces older large ones with a note', () => {
    const history = agenticTurn(10)
    const { history: next, cleared } = clearOldToolResults(history)
    expect(cleared).toBe(10 - KEEP_RECENT_TOOL_RESULTS)
    const results = next.flatMap((message) => message.content).filter((block) => block.type === 'tool_result')
    expect(results.slice(0, 4).every((block) => block.type === 'tool_result' && block.content.startsWith('[Older tool output cleared'))).toBe(true)
    expect(results.at(-1)).toMatchObject({ content: bigOutput(9) })
    expect(estimateHistoryTokens(next)).toBeLessThan(estimateHistoryTokens(history))
    // Already-cleared output is not cleared twice.
    expect(clearOldToolResults(next).cleared).toBe(0)
  })

  it('leaves the history untouched when there is nothing to clear', () => {
    const history = agenticTurn(3)
    expect(clearOldToolResults(history)).toEqual({ history, cleared: 0 })
  })

  it('stops replaying signed thinking blocks after a rewrite', () => {
    const history: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', text: 'plan', raw: { signature: 's' } }, { type: 'text', text: 'hi' }] },
    ]
    const next = withoutThinkingReplay(history)
    expect(next[0]?.content[0]).toEqual({ type: 'thinking', text: 'plan' })
    expect(withoutThinkingReplay(next)).toBe(next)
  })
})

describe('summary compaction', () => {
  it('carries an earlier summary forward whole and clears old output in the kept turns', async () => {
    const earlier = `[Earlier conversation summary]\n${'requirement '.repeat(2_000)}`
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: earlier }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier context loaded.' }] },
      { role: 'user', content: [{ type: 'text', text: 'older question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'older answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
      ...agenticTurn(10),
    ]
    const requests: ChatRequest[] = []
    const provider: Provider = {
      id: 'test',
      kind: 'openai',
      knownModels: () => [],
      listModels: async () => [],
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(request)
        yield { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text: 'merged summary' }] }
      },
    }
    const result = await compactHistory({ provider, model: 'm', history, maxTokens: 64_000, signal: new AbortController().signal })
    const sent = requests[0]!.messages[0]!.content[0]
    // The earlier summary (24k chars) is no longer cut down to 12k.
    expect(sent?.type === 'text' && sent.text.includes('requirement '.repeat(1_900))).toBe(true)
    expect(requests[0]!.maxTokens).toBeGreaterThanOrEqual(3_000)
    expect(result.clearedToolResults).toBe(10 - KEEP_RECENT_TOOL_RESULTS)
  })
})

describe('mid-turn trimming', () => {
  it('asks for a lighter history before each follow-up request of a turn', async () => {
    let call = 0
    const seen: number[] = []
    const provider: Provider = {
      id: 'test',
      kind: 'openai',
      knownModels: () => [],
      listModels: async () => [],
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push(request.messages.length)
        call += 1
        if (call === 1) {
          yield { type: 'done', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] }
        } else {
          yield { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
        }
      },
    }
    const read = {
      name: 'read', description: 'read', inputSchema: { type: 'object' }, defaultPermission: 'allow' as const,
      readOnly: true, summarize: () => 'read', execute: async () => ({ content: 'file' }),
    }
    const trims: number[] = []
    const notices: string[] = []
    await runTurn({
      provider, modelId: 'm', modelRef: 'p/m', system: '', maxTokens: 256, effort: 'medium', thinking: false,
      tools: { get: (name) => (name === 'read' ? read : undefined), schemas: () => [read] },
      permissions: { decide: () => 'allow', grantForSession: () => {} },
      usage: { record: () => {} }, cwd: process.cwd(),
      trimContext: (messages) => {
        trims.push(messages.length)
        return [{ role: 'user', content: [{ type: 'text', text: 'trimmed' }] }]
      },
    }, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], {
      onEvent: (event) => { if (event.type === 'notice') notices.push(event.text) },
      requestPermission: async () => 'once',
    }, new AbortController().signal)
    // Not before the first request; before the follow-up one.
    expect(trims).toEqual([3])
    expect(seen).toEqual([1, 1])
    expect(notices.some((text) => text.includes('cleared older tool output'))).toBe(true)
  })
})

describe('compaction budget estimate', () => {
  it('counts tokens, not characters, so a turn budget does not refuse it', async () => {
    const { estimateCompactBudget } = await import('../src/core/compact')
    const turn = (text: string) => [
      { role: 'user' as const, content: [{ type: 'text' as const, text }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
    ]
    const history = Array.from({ length: 30 }, (_, index) => turn(`${index} ${'x'.repeat(1_500)}`)).flat()
    const estimate = estimateCompactBudget(history)
    // Some 40k characters of older turns are ~10k tokens plus request overhead;
    // the old estimate counted the characters themselves (40k+).
    expect(estimate.inputTokens).toBeGreaterThan(10_000)
    expect(estimate.inputTokens).toBeLessThan(13_000)
  })
})
