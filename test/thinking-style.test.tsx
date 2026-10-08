process.env['FORCE_COLOR'] = '3'

import { describe, expect, it } from 'vitest'

const { renderToString } = await import('ink')
const { Transcript } = await import('../src/ui/components/Transcript')

const DIM = '\u001b[2m'

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
})
