import { renderToString } from 'ink'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { bashTool } from '../src/tools/bash'
import { PromptInput } from '../src/ui/components/PromptInput'
import { Transcript } from '../src/ui/components/Transcript'
import { stringsFor, StringsContext } from '../src/ui/i18n'
import { makeTheme, ThemeContext } from '../src/ui/theme'
import { applyEvents, emptyTranscript } from '../src/ui/transcript'

function wrap(node: ReactNode) {
  return (
    <ThemeContext.Provider value={makeTheme('purple')}>
      <StringsContext.Provider value={stringsFor('en')}>{node}</StringsContext.Provider>
    </ThemeContext.Provider>
  )
}

describe('live tool output', () => {
  it('reports the newest output line of a running command', async () => {
    const lines: string[] = []
    await bashTool.execute(
      { command: `"${process.execPath}" -e "console.log('step one'); setTimeout(() => console.log('step two'), 400)"` },
      {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        confirm: async () => true,
        onProgress: (text) => lines.push(text),
      },
    )
    expect(lines).toContain('step one')
    expect(lines.at(-1)).toBe('step two')
  })

  it('shows that line under the running call', () => {
    const state = applyEvents(emptyTranscript(), [
      { type: 'tool_start', id: 't1', name: 'bash', summary: 'bash(npm test)' },
      { type: 'tool_progress', id: 't1', text: 'PASS test/a.test.ts' },
    ])
    const output = renderToString(wrap(<Transcript bubbles={state.bubbles} workspace="w" />), { columns: 80 })
    expect(output).toContain('bash(npm test)')
    expect(output).toContain('└ PASS test/a.test.ts')
  })
})

describe('message queue', () => {
  it('lists waiting messages above the input', () => {
    const output = renderToString(wrap(
      <PromptInput
        disabled
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        history={[]}
        queued={['first follow-up', 'second', 'third', 'fourth']}
      />,
    ), { columns: 80 })
    expect(output).toContain('⏳ first follow-up')
    expect(output).toContain('⏳ third')
    expect(output).not.toContain('fourth')
    expect(output).toContain('pick one to edit')
  })
})
