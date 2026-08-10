import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { TerminalViewport, interactiveViewportRows } from '../src/ui/components/TerminalViewport'
import {
  Transcript,
  assistantThinkingForFrame,
  firstMutableBubbleIndex,
} from '../src/ui/components/Transcript'
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

  it('keeps the suffix live from the first concurrently running item', () => {
    const bubbles: Bubble[] = [
      { kind: 'user', id: 'user-1', text: 'message' },
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'read',
        state: 'running',
        summary: 'reading',
        content: '',
      },
      {
        kind: 'tool',
        id: 'tool-2',
        name: 'grep',
        state: 'running',
        summary: 'searching',
        content: '',
      },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'partial',
        thinking: '',
        streaming: true,
      },
    ]

    expect(firstMutableBubbleIndex(bubbles)).toBe(1)
  })

  it('treats a running subagent as mutable', () => {
    const bubbles: Bubble[] = [
      { kind: 'user', id: 'user-1', text: 'message' },
      {
        kind: 'subagent',
        id: 'subagent-1',
        description: 'checking tests',
        state: 'running',
        seq: 0,
        bubbles: [],
      },
    ]

    expect(firstMutableBubbleIndex(bubbles)).toBe(1)
  })

  it('freezes thinking above a streamed answer until the final render', () => {
    const streaming: Extract<Bubble, { kind: 'assistant' }> = {
      kind: 'assistant',
      id: 'assistant-1',
      text: 'visible answer',
      thinking: 'growing private reasoning',
      streaming: true,
    }

    const frozen = assistantThinkingForFrame(streaming)
    const later = { ...streaming, thinking: `${streaming.thinking}\nlater delta` }

    expect(assistantThinkingForFrame(later, frozen)).toBe(streaming.thinking)
    expect(assistantThinkingForFrame({ ...later, streaming: false }, frozen)).toBe(later.thinking)
  })
})

describe('terminal viewport', () => {
  it('always leaves one terminal row outside Ink\'s changing frame', () => {
    expect(interactiveViewportRows(24)).toBe(23)
    expect(interactiveViewportRows(1)).toBe(1)
  })

  it('clips changing output before it becomes a fullscreen frame', () => {
    const frame = renderToString(
      <TerminalViewport rows={8}>
        <Box
          flexDirection="column"
          flexShrink={1}
          overflowY="hidden"
          justifyContent="flex-end"
        >
          {Array.from({ length: 20 }, (_, index) => (
            <Text key={index}>line {index}</Text>
          ))}
        </Box>
      </TerminalViewport>,
      { columns: 80 },
    )

    expect(frame.split('\n')).toHaveLength(7)
    expect(frame).not.toContain('line 0')
    expect(frame).toContain('line 19')
  })
})
