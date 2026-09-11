import { Box, Text, renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import {
  TerminalViewport,
  interactiveViewportRows,
  liveTranscriptRows,
} from '../src/ui/components/TerminalViewport'
import {
  Transcript,
  assistantThinkingForFrame,
  clipTextToRows,
  firstMutableBubbleIndex,
} from '../src/ui/components/Transcript'
import { Picker } from '../src/ui/components/Picker'
import { PromptInput } from '../src/ui/components/PromptInput'
import { Markdown } from '../src/ui/markdown'
import stringWidth from 'string-width'
import { sanitizeThinkingText } from '../src/ui/sanitize'
import type { Bubble } from '../src/ui/types'

describe('transcript layout', () => {
  it('hides thinking tags, including incomplete streamed tags, without eating text', () => {
    expect(sanitizeThinkingText('<think>Reviewing loop-call disabling</think>')).toBe('Reviewing loop-call disabling')
    expect(sanitizeThinkingText('</think>Reviewing loop-call disabling')).toBe('Reviewing loop-call disabling')
    for (const suffix of ['<', '</', '</thi', '</think', '<think']) {
      expect(sanitizeThinkingText(`Reviewing${suffix}`, true)).toBe('Reviewing')
    }
    expect(sanitizeThinkingText('a < b', true)).toBe('a < b')
  })

  it('shows bounded subagent progress and then its actual result', () => {
    const sub: Extract<Bubble, { kind: 'subagent' }> = {
      kind: 'subagent', id: 'sub', description: 'checking', state: 'running', seq: 1,
      bubbles: [{ kind: 'assistant', id: 'a', text: '', thinking: '<think>' + 'old line\n'.repeat(100) + 'Reviewing</think>', streaming: true }],
    }
    const running = renderToString(<Transcript bubbles={[sub]} workspace="test" maxLiveRows={6} />, { columns: 80 })
    expect(running).toContain('subagent: checking')
    expect(running).toContain('Reviewing')
    expect(running).not.toContain('think>')
    const done = renderToString(<Transcript bubbles={[{ ...sub, state: 'done', result: 'Actual findings' }]} workspace="test" />, { columns: 80 })
    expect(done).toContain('Actual findings')
    expect(done).not.toContain('old line')
    expect(done).not.toContain('── result ──')
  })
  it.each([32, 80])('closes model and prompt frames within %s columns', (columns) => {
    const frames = [
      renderToString(<Picker title="Models" items={[{ key: 'model', label: 'model'.repeat(40), hint: 'hint'.repeat(40) }]} onSelect={() => {}} onCancel={() => {}} />, { columns }),
      renderToString(<PromptInput disabled={false} value={'message '.repeat(40)} onChange={() => {}} onSubmit={() => {}} history={[]} />, { columns }),
    ]
    for (const frame of frames) {
      const lines = frame.split('\n').filter((line) => line.trim() !== '')
      expect(lines.some((line) => line.endsWith('╮'))).toBe(true)
      expect(lines.some((line) => line.endsWith('╯'))).toBe(true)
      expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
    }
  })

  it('renders message separators as whitespace instead of copyable rules', () => {
    const frame = renderToString(<Markdown>{'before\n\n---\n\nafter'}</Markdown>, { columns: 32 })
    expect(frame).toContain('before')
    expect(frame).toContain('after')
    expect(frame).not.toContain('─')
  })
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
  it('leaves a blank row after Ink\'s trailing frame newline', () => {
    expect(interactiveViewportRows(24)).toBe(22)
    expect(interactiveViewportRows(Number.NaN)).toBe(22)
    expect(interactiveViewportRows(3)).toBe(1)
    expect(interactiveViewportRows(1)).toBe(1)
    expect(liveTranscriptRows(24)).toBe(8)
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

    expect(frame.split('\n')).toHaveLength(6)
    expect(frame).not.toContain('line 0')
    expect(frame).toContain('line 19')
  })

  it('keeps the footer visible when a long transcript reaches the viewport limit', () => {
    const frame = renderToString(
      <TerminalViewport rows={8}>
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflowY="hidden"
          justifyContent="flex-end"
        >
          {Array.from({ length: 20 }, (_, index) => (
            <Text key={index}>stream {index}</Text>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text>prompt</Text>
          <Text>status bottom</Text>
        </Box>
      </TerminalViewport>,
      { columns: 80 },
    )
    const lines = frame.split('\n')

    expect(lines).toHaveLength(6)
    expect(frame).not.toContain('stream 0')
    expect(frame).toContain('stream 19')
    expect(lines.at(-2)).toContain('prompt')
    expect(lines.at(-1)).toContain('status bottom')
  })

  it('keeps the footer visible under one multiline streamed answer', () => {
    const frame = renderToString(
      <TerminalViewport rows={12}>
        <Transcript
          workspace="/workspace/KitCode"
          maxLiveRows={4}
          bubbles={[
            {
              kind: 'assistant',
              id: 'assistant-stream',
              text: Array.from({ length: 30 }, (_, index) => `streamed ${index}`).join('\n'),
              thinking: '',
              streaming: true,
            },
          ]}
        />
        <Box flexDirection="column" flexShrink={0}>
          <Text>prompt bottom</Text>
          <Text>status bottom</Text>
        </Box>
      </TerminalViewport>,
      { columns: 80 },
    )
    const lines = frame.split('\n')

    // Static writes the four-line logo to scrollback outside Yoga's live box.
    expect(lines.length).toBeLessThanOrEqual(14)
    expect(frame).toContain('streamed 29')
    expect(frame).not.toContain('streamed 0\n')
    expect(lines.at(-2)).toContain('prompt bottom')
    expect(lines.at(-1)).toContain('status bottom')
  })

  it('clips wrapped streaming text from the start and keeps the newest rows', () => {
    expect(clipTextToRows('one\ntwo\nthree\nfour', 3, 80)).toBe('…\nthree\nfour')
    expect(clipTextToRows('123456789', 2, 4)).toBe('…\n9')
  })

  it('collapses an idle frame instead of leaving an empty screen above the footer', () => {
    const frame = renderToString(
      <TerminalViewport rows={8}>
        <Box flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden">
          <Text>finished answer</Text>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text>prompt</Text>
          <Text>status</Text>
        </Box>
      </TerminalViewport>,
      { columns: 80 },
    )

    expect(frame.split('\n')).toEqual(['finished answer', 'prompt', 'status'])
  })

  it('keeps the live prompt next to an answer committed through Static', () => {
    const frame = renderToString(
      <TerminalViewport rows={24}>
        <Transcript
          workspace="/workspace/KitCode"
          bubbles={[
            {
              kind: 'assistant',
              id: 'assistant-1',
              text: 'completed answer',
              thinking: '',
              streaming: false,
            },
          ]}
        />
        <Box flexDirection="column" flexShrink={0}>
          <Text>prompt</Text>
          <Text>status</Text>
        </Box>
      </TerminalViewport>,
      { columns: 80 },
    )
    const lines = frame.split('\n')
    const answerLine = lines.findIndex((line) => line.includes('completed answer'))
    const promptLine = lines.findIndex((line) => line.includes('prompt'))

    expect(answerLine).toBeGreaterThanOrEqual(0)
    expect(promptLine - answerLine).toBeLessThanOrEqual(3)
  })
})
