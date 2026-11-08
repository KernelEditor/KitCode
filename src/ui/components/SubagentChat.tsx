import { Box, Text } from 'ink'
import { useTerminalInput } from '../input'
import { subagentStatusLabel } from '../subagent-status'
import { useState } from 'react'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import type { Bubble } from '../types'
import { BubbleView } from './Transcript'

type SubagentBubble = Extract<Bubble, { kind: 'subagent' }>

// The body shows at most a screenful; re-rendering every finished step of a
// long run on each stream frame ground the UI to a halt with several agents.
const MAX_SHOWN_BUBBLES = 24

/**
 * Live view of one sub-agent's own conversation. It reads the bubble from the
 * transcript on every render, so new steps appear while the sub-agent works.
 * ↑/↓ step back through earlier messages; the newest ones show by default.
 */
export function SubagentChat({
  bubble,
  rows,
  onClose,
}: {
  bubble: SubagentBubble | undefined
  rows: number
  onClose: () => void
}) {
  const theme = useTheme()
  const strings = useStrings()
  // How many of the newest messages are hidden below the view.
  const [offset, setOffset] = useState(0)
  const total = bubble?.bubbles.length ?? 0

  useTerminalInput((_input, key) => {
    if (key.escape) onClose()
    else if (key.upArrow) setOffset((value) => Math.min(Math.max(0, total - 1), value + 1))
    else if (key.downArrow) setOffset((value) => Math.max(0, value - 1))
  })

  if (!bubble) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{strings.noSubagents}</Text>
        <Text dimColor>{strings.subagentBack}</Text>
      </Box>
    )
  }

  const running = bubble.state === 'running'
  const shown = bubble.bubbles.slice(Math.max(0, total - offset - MAX_SHOWN_BUBBLES), total - offset)
  const bodyRows = Math.max(3, rows - (bubble.reason ? 3 : 2))

  return (
    <Box flexDirection="column" minWidth={0}>
      <Text color={running || bubble.state === 'cancelled' || bubble.state === 'incomplete' ? theme.warn : bubble.state === 'error' ? theme.error : theme.ok} bold wrap="truncate-end">
        {running ? '◌' : '●'} {bubble.description}
        <Text dimColor bold={false}>
          {' · '}{subagentStatusLabel(bubble.state, strings)}
        </Text>
      </Text>
      {bubble.reason && <Text color={theme.warn} wrap="truncate-end">{bubble.reason}</Text>}
      <Box
        flexDirection="column"
        height={bodyRows}
        overflowY="hidden"
        justifyContent="flex-end"
        minWidth={0}
      >
        {shown.length === 0 && !bubble.result && <Text dimColor>{strings.subagentWaiting}</Text>}
        {shown.map((inner) => (
          <BubbleView key={inner.id} bubble={inner} maxRows={bodyRows} />
        ))}
        {offset === 0 && !running && bubble.result && shown.length === 0 && (
          <Text>{bubble.result}</Text>
        )}
      </Box>
      <Text dimColor>
        {strings.subagentBack} · ↑/↓{offset > 0 ? ` · −${offset}` : ''}
      </Text>
    </Box>
  )
}
