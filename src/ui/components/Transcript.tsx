import { Box, Static, Text } from 'ink'
import { memo, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import Spinner from 'ink-spinner'
import { diffLines, truncate } from '../diff'
import { Markdown } from '../markdown'
import { useTheme } from '../theme'
import type { Bubble, TranscriptProps } from '../types'
import { DiffHunk } from './Diff'
import { Logo } from './Logo'

const HEADER = { kind: 'header' } as const
type StaticTranscriptItem = typeof HEADER | Bubble
type AssistantBubble = Extract<Bubble, { kind: 'assistant' }>

export function assistantThinkingForFrame(
  bubble: AssistantBubble,
  frozenThinking?: string,
): string {
  return bubble.streaming && bubble.text !== ''
    ? (frozenThinking ?? bubble.thinking)
    : bubble.thinking
}

export function firstMutableBubbleIndex(bubbles: Bubble[]): number {
  return bubbles.findIndex(
    (bubble) =>
      (bubble.kind === 'assistant' && bubble.streaming) ||
      (bubble.kind === 'tool' && bubble.state === 'running') ||
      (bubble.kind === 'subagent' && bubble.state === 'running'),
  )
}

export const Transcript = memo(function Transcript({ bubbles, workspace }: TranscriptProps) {
  // A Static item cannot be updated after Ink writes it to scrollback. Keep the
  // whole suffix starting at the first mutable bubble live: several tools or
  // subagents may be running concurrently.
  const liveAt = firstMutableBubbleIndex(bubbles)
  const stableCount = liveAt === -1 ? bubbles.length : liveAt
  const stableRef = useRef<Bubble[]>([])
  if (stableRef.current.length < stableCount) {
    stableRef.current = [
      ...stableRef.current,
      ...bubbles.slice(stableRef.current.length, stableCount),
    ]
  } else if (stableRef.current.length > stableCount) {
    stableRef.current = bubbles.slice(0, stableCount)
  }
  const live = liveAt === -1 ? [] : bubbles.slice(liveAt)
  const staticItems: StaticTranscriptItem[] = [HEADER, ...stableRef.current]

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      flexShrink={1}
      minHeight={0}
      overflowY="hidden"
    >
      <Static items={staticItems}>
        {(item) =>
          item.kind === 'header' ? (
            <Logo key="kitcode-header" workspace={workspace} />
          ) : (
            <BubbleView key={item.id} bubble={item} />
          )
        }
      </Static>

      <Box
        flexDirection="column"
        flexShrink={1}
        minHeight={0}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {live.map((bubble) => (
          <BubbleView key={bubble.id} bubble={bubble} />
        ))}
      </Box>
    </Box>
  )
})

const BubbleView = memo(function BubbleView({ bubble }: { bubble: Bubble }) {
  const theme = useTheme()

  if (bubble.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          › {bubble.text}
        </Text>
      </Box>
    )
  }

  if (bubble.kind === 'notice') {
    const color =
      bubble.level === 'error' ? theme.error : bubble.level === 'warn' ? theme.warn : theme.accent
    return (
      <Box marginTop={1}>
        <Text color={color}>{bubble.text}</Text>
      </Box>
    )
  }

  if (bubble.kind === 'assistant') {
    return <AssistantView bubble={bubble} />
  }

  if (bubble.kind === 'subagent') {
    return <SubagentView bubble={bubble} />
  }

  return <ToolView bubble={bubble} />
})

function AssistantView({ bubble }: { bubble: AssistantBubble }) {
  const frozenThinking = useRef<string | undefined>(undefined)
  const answering = bubble.streaming && bubble.text !== ''
  if (!answering) frozenThinking.current = undefined
  if (answering && frozenThinking.current === undefined) {
    frozenThinking.current = bubble.thinking
  }
  const visibleThinking = assistantThinkingForFrame(bubble, frozenThinking.current)

  return (
    <Box flexDirection="column" marginTop={1}>
      {visibleThinking.trim() !== '' && (
        <Text dimColor italic>
          {visibleThinking.trim()}
        </Text>
      )}
      {bubble.streaming ? <Text>{bubble.text}</Text> : <Markdown>{bubble.text}</Markdown>}
      {bubble.streaming && bubble.text === '' && (
        <Text dimColor>
          <Spinner type="dots" /> thinking
        </Text>
      )}
    </Box>
  )
}

function ToolView({ bubble }: { bubble: Extract<Bubble, { kind: 'tool' }> }) {
  const theme = useTheme()
  const mark = bubble.state === 'running' ? '◌' : bubble.state === 'ok' ? '●' : '✗'
  const color =
    bubble.state === 'error' ? theme.error : bubble.state === 'ok' ? theme.ok : theme.warn
  const display = bubble.display
  const diff = useMemo(
    () => (display?.kind === 'diff' ? diffLines(display.before, display.after) : null),
    [display],
  )
  if (!diff) return <NonDiffToolView bubble={bubble} mark={mark} color={color} />
  const hasChanges = diff.added > 0 || diff.removed > 0

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>
        {mark} {bubble.summary}
        {hasChanges && (
          <>
            {diff.added > 0 && <Text color={theme.ok} bold>{` +${diff.added}`}</Text>}
            {diff.removed > 0 && <Text color={theme.error} bold>{` -${diff.removed}`}</Text>}
          </>
        )}
      </Text>
      <Box marginLeft={2}>
        <DiffHunk lines={diff.hunk} hidden={diff.hidden} />
      </Box>
    </Box>
  )
}

function NonDiffToolView({
  bubble,
  mark,
  color,
}: {
  bubble: Extract<Bubble, { kind: 'tool' }>
  mark: string
  color: string
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>
        {mark} {bubble.summary}
      </Text>
      {bubble.state !== 'running' &&
        bubble.content.trim() !== '' && (
          <Box flexDirection="column" marginLeft={2}>
            {previewLines(bubble.content).map((line, index) => (
              <Text key={index} dimColor>
                {truncate(line, 110)}
              </Text>
            ))}
          </Box>
        )}
    </Box>
  )
}

function previewLines(content: string): string[] {
  const lines = content.split('\n').filter((line) => line.trim() !== '')
  if (lines.length <= 6) return lines
  return [...lines.slice(0, 6), `… ${lines.length - 6} more lines`]
}

function SubagentView({ bubble }: { bubble: Extract<Bubble, { kind: 'subagent' }> }) {
  const theme = useTheme()
  const mark = bubble.state === 'running' ? '◌' : '●'
  const color = bubble.state === 'running' ? theme.warn : theme.ok

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color} bold>
        {mark} subagent: {bubble.description}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {bubble.bubbles.map((inner, index) => (
          <BubbleView key={index} bubble={inner} />
        ))}
        {bubble.state === 'done' && bubble.result && (
          <Box marginTop={1}>
            <Text dimColor>── result ──</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
