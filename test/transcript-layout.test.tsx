import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/ui/components/Transcript'
import type { Bubble } from '../src/ui/types'

describe('transcript layout', () => {
  it('keeps the session header before completed messages', () => {
    const bubbles: Bubble[] = [
      { kind: 'user', id: 'user-1', text: 'first message' },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'first answer',
        thinking: '',
        streaming: false,
      },
    ]

    const frame = renderToString(
      <Transcript bubbles={bubbles} workspace="/workspace/KitCode" />,
      { columns: 80 },
    )

    expect(frame.indexOf('kitcode')).toBeGreaterThanOrEqual(0)
    expect(frame.indexOf('kitcode')).toBeLessThan(frame.indexOf('first message'))
    expect(frame.indexOf('first message')).toBeLessThan(frame.indexOf('first answer'))
  })
})
