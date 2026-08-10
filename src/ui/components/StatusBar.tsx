import { Box, Text } from 'ink'
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { dollars } from '../../core/usage'
import type { Effort } from '../../providers/types'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { formatDuration } from '../time'
import { sanitizeTerminalText } from '../sanitize'
import type { StatusBarProps } from '../types'

const BAR_WIDTH = 12

export function StatusBar({ status }: StatusBarProps) {
  const theme = useTheme()
  const strings = useStrings()

  const primary: ReactNode[] = []
  const details: ReactNode[] = []

  primary.push(<ModelBadge key="model" ref={status.modelRef} />)
  primary.push(<EffortLabel key="effort" effort={status.effort} />)
  if (!status.thinking) {
    details.push(
      <Text key="think" color={theme.warn}>
        {strings.noThink}
      </Text>,
    )
  }
  if (status.mode !== 'normal') {
    const modeColor = status.mode === 'accept' ? 'yellow' : status.mode === 'plan' ? 'blue' : theme.accent
    details.push(
      <Text key="mode" color={modeColor}>
        {strings.modeLabel[status.mode] ?? status.mode}
      </Text>,
    )
  }

  if (status.usage) {
    const u = status.usage
    details.push(
      <Text key="usage">
        <Text color="white" bold>{u.input}</Text>
        <Text dimColor> ↑ </Text>
        <Text color={theme.ok}>{u.output}</Text>
        <Text dimColor> ↓</Text>
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

  if (status.bypass) {
    details.push(
      <Text key="bypass" color="black" backgroundColor={theme.warn} bold>
        {' '}BYPASS{' '}
      </Text>,
    )
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
          <Segments items={primary} />
        </Box>
        <Box
          flexShrink={0}
          marginLeft={2}
          flexDirection="column"
          alignItems="flex-end"
        >
          <ContextMeter context={status.context} />
          {(status.mcp.connected > 0 || status.mcp.failed > 0) && (
            <Text>
              {status.mcp.connected > 0 && (
                <Text color={theme.ok}>mcp:{status.mcp.connected}</Text>
              )}
              {status.mcp.connected > 0 && status.mcp.failed > 0 && (
                <Text dimColor> · </Text>
              )}
              {status.mcp.failed > 0 && (
                <Text color={theme.error}>{strings.mcpFailed(status.mcp.failed)}</Text>
              )}
            </Text>
          )}
          {status.activeAgents > 0 && (
            <Text color={theme.accent}>{strings.activeAgents(status.activeAgents)}</Text>
          )}
        </Box>
      </Box>
      {details.length > 0 && (
        <Box flexWrap="wrap">
          {details.map((item, index) => (
            <Fragment key={index}>
              {index > 0 && <Text dimColor> · </Text>}
              {item}
            </Fragment>
          ))}
        </Box>
      )}
    </Box>
  )
}

function Segments({ items }: { items: ReactNode[] }) {
  return items.flatMap((item, index) => {
    const elements: ReactNode[] = []
    if (index > 0) {
      elements.push(
        <Box key={`sep-${index}`} marginTop={1}>
          <Text dimColor>{' · '}</Text>
        </Box>,
      )
    }
    elements.push(<Fragment key={`item-${index}`}>{item}</Fragment>)
    return elements
  })
}

function shortModel(ref: string): string {
  const safe = sanitizeTerminalText(ref)
  const slash = safe.lastIndexOf('/')
  return slash === -1 ? safe : safe.slice(slash + 1)
}

function ModelBadge({ ref: modelRef }: { ref: string }) {
  const theme = useTheme()
  const name = shortModel(modelRef)
  return (
    <Box borderColor={theme.accent} borderStyle="round" paddingX={1}>
      <Text color={theme.accent} bold>{name}</Text>
    </Box>
  )
}

const EFFORT_STYLES: Record<
  Effort,
  { label: string; color?: string; bold?: boolean; dim?: boolean }
> = {
  max: { label: 'max', color: 'red', bold: true },
  xhigh: { label: 'xhigh', color: 'yellow', bold: true },
  high: { label: 'high', color: 'cyan' },
  medium: { label: 'medium', color: 'blue' },
  low: { label: 'low', color: 'gray', dim: true },
}

function EffortLabel({ effort }: { effort: Effort }) {
  const style = EFFORT_STYLES[effort]
  return (
    <Box borderColor={style.color ?? 'gray'} borderStyle="round" paddingX={1}>
      <Text
        color={style.color}
        bold={style.bold}
        dimColor={style.dim}
      >
        {style.label}
      </Text>
    </Box>
  )
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  const [value, suffix] = count < 1_000_000 ? [count / 1000, 'k'] : [count / 1_000_000, 'M']
  return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

function ContextMeter({
  context,
}: {
  context: { window: number | null; used: number; exact: boolean }
}) {
  const theme = useTheme()
  const { window: win, used, exact } = context
  if (!exact || win === null || win <= 0) {
    return (
      <Text>
        <Text dimColor>ctx </Text>
        <Text color="gray">{exact ? tokens(used) : '?'}</Text>
        {win && win > 0 && <Text dimColor>/{tokens(win)}</Text>}
      </Text>
    )
  }
  const pct = Math.min(Math.max(used / win, 0), 1)
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * pct)))

  const color = pct < 0.6 ? theme.ok : pct < 0.85 ? theme.warn : theme.error
  const percent = Math.round(pct * 100)

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
