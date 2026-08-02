import { Box, Text } from 'ink'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'

const CAT = ['  ╱\\_╱\\ ', ' ( o.o )', '  > ^ <  ']

export function Logo({ subtitle }: { subtitle?: string }) {
  const theme = useTheme()
  const strings = useStrings()
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column">
        {CAT.map((line) => (
          <Text key={line} color={theme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        <Text color={theme.accent} bold>
          kitcode
        </Text>
        <Text dimColor>{subtitle ?? strings.hint}</Text>
      </Box>
    </Box>
  )
}
