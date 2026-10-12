import { renderToString } from 'ink'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { StatusBar } from '../src/ui/components/StatusBar'
import { SubagentChat } from '../src/ui/components/SubagentChat'
import { stringsFor, StringsContext } from '../src/ui/i18n'
import { makeTheme, ThemeContext } from '../src/ui/theme'
import { applyEvents, emptyTranscript } from '../src/ui/transcript'
import type { Bubble } from '../src/ui/types'

function wrap(node: ReactNode) {
  return createElement(
    ThemeContext.Provider,
    { value: makeTheme('purple') },
    createElement(StringsContext.Provider, { value: stringsFor('en') }, node),
  )
}

function statusWith(agents: string[]) {
  return renderToString(wrap(createElement(StatusBar, {
    status: {
      modelRef: 'provider/test-model', effort: 'high', effectiveEffort: 'high', thinking: true,
      usage: null, speed: null, mcp: { connected: 0, failed: 0 }, mode: 'normal', bypass: false,
      busy: true, sessionMs: 1_000, turnMs: 1_000, agents,
      context: { window: 100_000, used: 50_000, exact: true },
    },
  })), { columns: 120 })
}

describe('sub-agent UI', () => {
  it('lists the first running tasks in the status bar and counts the rest', () => {
    const output = statusWith(['find callers of foo', 'audit the config loader for path bugs', 'read tests', 'scan docs', 'check CI'])
    expect(output).toContain('◌ find callers of foo')
    expect(output).toContain('◌ audit the config loader for…')
    expect(output).toContain('◌ read tests')
    expect(output).not.toContain('scan docs')
    expect(output).toContain('+2 more')
  })

  it('shows a running sub-agent chat with its own steps', () => {
    const state = applyEvents(emptyTranscript(), [
      { type: 'subagent_start', id: 'sa1', description: 'find callers' },
      { type: 'subagent_event', id: 'sa1', event: { type: 'turn_start' } },
      { type: 'subagent_event', id: 'sa1', event: { type: 'text_delta', text: 'Searching the repo for foo.' } },
      { type: 'subagent_event', id: 'sa1', event: { type: 'tool_start', id: 't1', name: 'grep', summary: 'grep(foo)' } },
    ])
    const bubble = state.bubbles.find((item): item is Extract<Bubble, { kind: 'subagent' }> => item.kind === 'subagent')
    const output = renderToString(wrap(createElement(SubagentChat, { bubble, rows: 12, onClose: () => {} })), { columns: 100 })
    expect(output).toContain('find callers')
    expect(output).toContain('running')
    expect(output).toContain('Searching the repo for foo.')
    expect(output).toContain('grep(foo)')
    expect(output).toContain('esc back')
  })
})
