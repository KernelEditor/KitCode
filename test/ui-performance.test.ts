import { renderToString } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/types'
import { normalizeOpenAiUsage } from '../src/providers/openai-compat'
import { StatusBar } from '../src/ui/components/StatusBar'
import { stringsFor, StringsContext } from '../src/ui/i18n'
import { makeTheme, ThemeContext } from '../src/ui/theme'
import { applyEvents, emptyTranscript } from '../src/ui/transcript'

describe('stream rendering', () => {
  it('applies a frame of small deltas as one assistant bubble', () => {
    const events: AgentEvent[] = Array.from({ length: 100 }, () => ({
      type: 'text_delta',
      text: 'x',
    }))
    const state = applyEvents(emptyTranscript(), events)
    expect(state.bubbles).toEqual([
      { kind: 'assistant', id: 'a0', text: 'x'.repeat(100), thinking: '', streaming: true },
    ])
    expect(state.seq).toBe(1)
  })

  it('closes streamed text even when a cancellation notice follows it', () => {
    const state = applyEvents(emptyTranscript(), [
      { type: 'text_delta', text: 'partial' },
      { type: 'notice', level: 'warn', text: 'Cancelled.' },
      { type: 'turn_end', stopReason: 'aborted' },
    ])
    expect(state.bubbles[0]).toMatchObject({ kind: 'assistant', streaming: false })
  })
})

describe('OpenAI usage normalization', () => {
  it('keeps cached prompt tokens in an exclusive bucket', () => {
    expect(
      normalizeOpenAiUsage({
        prompt_tokens: 10_000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 8_000 },
      }),
    ).toEqual({ input: 2_000, output: 500, cacheWrite: 0, cacheRead: 8_000 })
  })
})

describe('bottom status panel', () => {
  it('renders one left-to-right context capsule on the right side', () => {
    const panel = createElement(
      ThemeContext.Provider,
      { value: makeTheme('purple') },
      createElement(
        StringsContext.Provider,
        { value: stringsFor('en') },
        createElement(StatusBar, {
          status: {
            modelRef: 'provider/test-model',
            effort: 'high',
            thinking: true,
            usage: null,
            mcp: { connected: 0, failed: 0 },
            mode: 'normal',
            bypass: false,
            busy: false,
            sessionMs: 1_000,
            turnMs: null,
            context: { window: 100_000, used: 50_000 },
            budget: {
              requests: { remaining: 31, limit: 32 },
              tokens: { remaining: 900_000, limit: 1_000_000 },
              costUsd: { remaining: 4.75, limit: 5 },
            },
          },
        }),
      ),
    )
    const output = renderToString(panel, { columns: 100 })
    const statusLine = output.split('\n').find((line) => line.includes('ctx')) ?? ''

    expect(output.match(/ctx/g)).toHaveLength(1)
    expect(statusLine.indexOf('ctx')).toBeGreaterThan(statusLine.indexOf('test-model'))
    expect(statusLine).toContain('50%')
    expect(statusLine).toContain('▐')
    expect(statusLine).toContain('█')
    expect(statusLine).toContain('░')
    expect(statusLine).toContain('▌')
    expect(output).toContain('left 31 req')
    expect(output).toContain('900k tok')
    expect(output).toContain('$4.75')
  })
})
