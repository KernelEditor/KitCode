import { Box, Text } from 'ink'
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
    details.push(
      <Text key="mode" color={theme.accent}>
        {strings.modeLabel[status.mode] ?? status.mode}
      </Text>,
    )
  }

  if (status.usage) {
    const u = status.usage
    details.push(
      <Text key="usage">
        <Text color={theme.accent}>{u.input}</Text>
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

  if (status.mcp.connected > 0) {
    details.push(
      <Text key="mcp" color={theme.ok}>
        mcp:{status.mcp.connected}
      </Text>,
    )
  }
  if (status.mcp.failed > 0) {
    details.push(
      <Text key="mcpfail" color={theme.error}>
        {strings.mcpFailed(status.mcp.failed)}
      </Text>,
    )
  }

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
        <Box flexShrink={0} marginLeft={2} justifyContent="flex-end">
          <ContextMeter context={status.context} />
        </Box>
      </Box>
      {details.length > 0 && (
        <Box flexWrap="wrap">
          <Segments items={details} />
        </Box>
      )}
    </Box>
  )
}

function Segments({ items }: { items: ReactNode[] }) {
  return items.map((item, index) => (
    <Text key={index}>
      {index > 0 && <Text dimColor> · </Text>}
      {item}
    </Text>
  ))
}

function shortModel(ref: string): string {
  const safe = sanitizeTerminalText(ref)
  const slash = safe.lastIndexOf('/')
  return slash === -1 ? safe : safe.slice(slash + 1)
}

// Coloured badge for the active model: inverse colour (accent background,
// black text) so it reads as a chip/pill rather than plain text.
function ModelBadge({ ref: modelRef }: { ref: string }) {
  const theme = useTheme()
  const name = shortModel(modelRef)
  return (
    <Text color="black" backgroundColor={theme.accent} bold>
      {` ${name} `}
    </Text>
  )
}

// Visual styling for the reasoning/effort level.
// "max" is hottest — bright yellow background; each lower level fades out.
const EFFORT_STYLES: Record<
  Effort,
  { label: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; underline?: boolean }
> = {
  max: { label: 'max', color: 'black', bg: 'yellow', bold: true, underline: true },
  xhigh: { label: 'xhigh', bold: true },
  high: { label: 'high' },
  medium: { label: 'medium', dim: true },
  low: { label: 'low', color: 'gray', dim: true },
}

function EffortLabel({ effort }: { effort: Effort }) {
  const theme = useTheme()
  const style = EFFORT_STYLES[effort]
  const color = style.color ?? theme.accent
  return (
    <Text
      color={color}
      backgroundColor={style.bg}
      bold={style.bold}
      dimColor={style.dim}
      underline={style.underline}
    >
      {style.bg ? ` ${style.label} ` : style.label}
    </Text>
  )
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  const [value, suffix] = count < 1_000_000 ? [count / 1000, 'k'] : [count / 1_000_000, 'M']
  return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

// Context-window meter. The capsule fills left-to-right and shifts
// green → yellow → red as the request approaches the model limit.
function ContextMeter({
  context,
}: {
  context: { window: number | null; used: number }
}) {
  const theme = useTheme()
  const { window: win, used } = context
  if (win === null || win <= 0) {
    return (
      <Text>
        <Text dimColor>ctx ? </Text>
        <Text color="gray">▐{'░'.repeat(BAR_WIDTH)}▌</Text>
        <Text dimColor> {tokens(used)}</Text>
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
