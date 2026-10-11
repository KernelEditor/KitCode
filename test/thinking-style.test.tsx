process.env['FORCE_COLOR'] = '3'

import { describe, expect, it } from 'vitest'

const { renderToString } = await import('ink')
const { Transcript } = await import('../src/ui/components/Transcript')

const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'

describe('thinking styling', () => {
  it('greys out reasoning and leaves the answer at full brightness', () => {
    const frame = renderToString(
      <Transcript
        workspace="test"
        bubbles={[
          {
            kind: 'assistant',
            id: 'a',
            text: 'Final answer',
            thinking: 'Reviewing the plan',
            streaming: false,
          },
        ]}
      />,
      { columns: 80 },
    )
    const lines = frame.split('\n')
    expect(lines.find((line) => line.includes('Reviewing the plan'))).toContain(DIM)
    expect(lines.find((line) => line.includes('Final answer'))).not.toContain(DIM)
  })

  it('does not override dim reasoning with Markdown accent colors', () => {
    const frame = renderToString(
      <Transcript
        workspace="test"
        bubbles={[{
          kind: 'assistant',
          id: 'a',
          text: '',
          thinking: '```\nconst value = 1\n```',
          streaming: false,
        }]}
      />,
      { columns: 80 },
    )
    const line = frame.split('\n').find((value) => value.includes('const value'))
    expect(line).toContain(DIM)
    expect(line).not.toContain('\u001b[36m')
  })

  it('keeps reasoning faint even where Markdown would bold a span', () => {
    const frame = renderToString(
      <Transcript
        workspace="test"
        bubbles={[{
          kind: 'assistant',
          id: 'a',
          text: 'Mention `reasoning` here',
          streaming: false,
          thinking: '## Plan\n\nEdit `src/ui/markdown.tsx` and **bold** the rest\n',
        }]}
      />,
      { columns: 80 },
    )
    const reasoning = frame.split('\n').filter((line) => line.includes('Plan') || line.includes('Edit'))
    expect(reasoning).toHaveLength(2)
    for (const line of reasoning) {
      expect(line).toContain(DIM)
      expect(line).not.toContain(BOLD)
    }
    expect(frame.split('\n').find((line) => line.includes('Mention'))).toContain(BOLD)
  })
})
