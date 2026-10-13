import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { dollars, tokens } from '../../core/usage'
import type { Effort } from '../../providers/types'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { formatDuration } from '../time'
import { sanitizeTerminalText } from '../sanitize'
import { useTerminalSize } from '../terminal-size'
import type { StatusBarProps } from '../types'

const BAR_WIDTH = 12
const VISIBLE_AGENTS = 3
const AGENT_LABEL_WIDTH = 28

function shortTask(task: string): string {
  const label = sanitizeTerminalText(task).replace(/\s+/g, ' ').trim() || 'subagent'
  return label.length <= AGENT_LABEL_WIDTH ? label : `${label.slice(0, AGENT_LABEL_WIDTH - 1)}…`
}

export function StatusBar({ status }: StatusBarProps) {
  const theme = useTheme()
  const strings = useStrings()

  // One line: every row spent here is a row the live answer cannot use.
  const details: ReactNode[] = []

  details.push(<Text key="model" color={theme.accent} bold>{shortModel(status.modelRef)}</Text>)
  details.push(<EffortLabel key="effort" effort={status.effort} effective={status.effectiveEffort} />)
  if (!status.thinking) {
    details.push(
      <Text key="think" color={theme.warn}>
        {strings.noThink}
      </Text>,
    )
  }
  // The permission mode and BYPASS are shown on the prompt frame, not here.
  if (status.usage && status.usage.totalTokens > 0) {
    const u = status.usage
    details.push(
      <Text key="usage">
        <Text color="white" bold>{u.input}</Text>
        <Text dimColor>↑ </Text>
        <Text color={theme.ok}>{u.output}</Text>
        <Text dimColor>↓</Text>
        {u.cache && (
          <>
            <Text dimColor> (</Text>
            <Text color="gray">{u.cache} cache</Text>
            <Text dimColor>)</Text>
          </>
        )}
        {u.costUsd !== null && u.costUsd > 0 && (
          <>
            <Text dimColor> · </Text>
            <Text color={theme.warn} bold>
              {dollars(u.costUsd)}
            </Text>
          </>
        )}
      </Text>,
    )
  }

  if (status.speed) {
    const rate = status.speed.tokensPerSecond
    details.push(
      <Text key="speed">
        <Text color={status.speed.live ? theme.accent : 'white'} bold={!status.speed.live}>
          {`${status.speed.live ? '~' : ''}${rate < 10 ? rate.toFixed(1) : Math.round(rate)}`}
        </Text>
        <Text dimColor> tok/s</Text>
      </Text>,
    )
  }

  details.push(
    <Text
      key="elapsed"
      color={status.turnMs !== null ? theme.accent : undefined}
      bold={status.turnMs !== null}
    >
      {status.turnMs === null
        ? strings.sessionFor(formatDuration(status.sessionMs))
        : `${strings.working} ${formatDuration(status.turnMs)}`}
    </Text>,
  )

  if (status.mcp.connected > 0) {
    details.push(<Text key="mcp" color={theme.ok}>mcp:{status.mcp.connected}</Text>)
  }
  if (status.mcp.failed > 0) {
    details.push(<Text key="mcp-failed" color={theme.error}>{strings.mcpFailed(status.mcp.failed)}</Text>)
  }

  return (
    <Box
      width="100%"
      flexShrink={0}
      marginTop={1}
      paddingX={1}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.accent}
      borderDimColor
      alignItems="flex-start"
      flexDirection="column"
    >
      <Box width="100%" alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1} flexWrap="wrap">
          {/* The separator travels with its item so a wrap never strands a lone dot. */}
          {/* flexShrink 0: an item moves to the next line whole instead of
              breaking mid-word ("claude-sonnet-" / "5") on a narrow terminal. */}
          {details.map((item, index) => (
            <Box key={index} flexShrink={0}>
              <Text>
                {index > 0 && <Text dimColor> · </Text>}
                {item}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <ContextMeter context={status.context} />
        </Box>
      </Box>
      {status.agents.length > 0 && (
        <Box width="100%" flexDirection="column" alignItems="flex-end">
          {status.agents.slice(0, VISIBLE_AGENTS).map((task, index) => (
            <Text key={index} color={theme.accent} wrap="truncate-end">
              ◌ {shortTask(task)}
            </Text>
          ))}
          {status.agents.length > VISIBLE_AGENTS && (
            <Text dimColor>{strings.moreAgents(status.agents.length - VISIBLE_AGENTS)}</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

function shortModel(ref: string): string {
  const safe = sanitizeTerminalText(ref)
  const slash = safe.lastIndexOf('/')
  return slash === -1 ? safe : safe.slice(slash + 1)
}

const EFFORT_STYLES: Record<
  Effort,
  { label: string; color?: string; bold?: boolean; dim?: boolean }
> = {
  auto: { label: 'auto', color: 'cyan' },
  max: { label: 'max', color: 'red', bold: true },
  xhigh: { label: 'xhigh', color: 'yellow', bold: true },
  high: { label: 'high', color: 'cyan' },
  medium: { label: 'medium', color: 'blue' },
  low: { label: 'low', color: 'gray', dim: true },
}

function EffortLabel({ effort, effective }: { effort: Effort; effective: Exclude<Effort, 'auto'> | null }) {
  const style = EFFORT_STYLES[effort]
  // The model ignores effort entirely: show the setting struck through so it
  // is not mistaken for something that affects the request.
  if (effective === null) {
    return <Text color="gray" dimColor strikethrough>{style.label}</Text>
  }
  // auto resolves per request; other levels may be capped to what the model supports.
  const sent = effective !== effort ? EFFORT_STYLES[effective] : undefined
  return (
    <Text>
      <Text color={style.color} bold={style.bold} dimColor={style.dim}>
        {style.label}
      </Text>
      {sent && (
        <>
          <Text dimColor>{effort === 'auto' ? '·' : '→'}</Text>
          <Text color={sent.color} bold={sent.bold} dimColor={sent.dim}>{sent.label}</Text>
        </>
      )}
    </Text>
  )
}

function ContextMeter({
  context,
}: {
  context: { window: number | null; used: number; exact: boolean }
}) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  // Below ~80 columns the bar costs the line its other details; the figure stays.
  const compact = columns < 80
  const { window: win, exact } = context
  // Before the first answer for this model there is no provider count yet;
  // nothing has been sent, so 0 is the honest figure.
  const used = exact ? context.used : 0
  if (win === null || win <= 0) {
    return (
      <Text>
        <Text dimColor>ctx </Text>
        <Text color="gray">{tokens(used)}</Text>
      </Text>
    )
  }
  const pct = Math.min(Math.max(used / win, 0), 1)
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * pct)))

  const color = pct < 0.6 ? theme.ok : pct < 0.85 ? theme.warn : theme.error
  const percent = Math.round(pct * 100)

  if (compact) {
    return (
      <Text>
        <Text dimColor>ctx </Text>
        <Text color={color} bold>{`${percent}%`}</Text>
      </Text>
    )
  }
  return (
    <Text>
      <Text dimColor>ctx </Text>
      <Text color={color} bold>
        {`${percent}%`.padStart(4)}
      </Text>
      <Text color={color}> ▐{'█'.repeat(filled)}</Text>
      <Text color="gray" dimColor>{'░'.repeat(BAR_WIDTH - filled)}</Text>
      <Text color={color}>▌</Text>
      <Text dimColor> {tokens(used)}/{tokens(win)}</Text>
    </Text>
  )
}
