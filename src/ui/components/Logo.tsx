import { Box, Text, useWindowSize } from 'ink'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { formatWorkspacePath } from '../workspace'
import { KITCODE_VERSION } from '../../version'

const CAT = ['  ╱\\_╱\\ ', ' ( o.o )', '  > ^ <  ']

export function Logo({ subtitle, workspace }: { subtitle?: string; workspace?: string }) {
  const theme = useTheme()
  const strings = useStrings()
  const { columns } = useWindowSize()
  const location = workspace
    ? formatWorkspacePath(workspace, Math.max(6, Math.min(72, columns - 15)))
    : ''

  return (
    <Box width="100%" marginBottom={1}>
      <Box flexDirection="column" flexShrink={0}>
        {CAT.map((line) => (
          <Text key={line} color={theme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} flexGrow={1} flexShrink={1} minWidth={0}>
        <Box>
          <Text color={theme.accent} bold>
            kitcode
          </Text>
          <Text dimColor> v{KITCODE_VERSION}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{subtitle ?? strings.hint}</Text>
        {location && (
          <Box width="100%">
            <Text color={theme.accent}>⌂ </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-start">{location}</Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}
