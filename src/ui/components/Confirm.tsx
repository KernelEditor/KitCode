import { Box, Text } from 'ink'
import { useTerminalInput } from '../input'
import { normalizeHotkey } from '../layout'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { sanitizeTerminalText } from '../sanitize'
import type { ConfirmProps } from '../types'

export function Confirm({ title, body, danger, onAnswer }: ConfirmProps) {
  const theme = useTheme()
  const strings = useStrings()
  useTerminalInput((char, key) => {
    const c = normalizeHotkey(char)
    if (c === 'y') onAnswer(true)
    else if (c === 'n' || key.escape || key.return) onAnswer(false)
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={danger ? theme.error : theme.warn}
      paddingX={1}
    >
      <Text bold color={danger ? theme.error : theme.warn}>
        {sanitizeTerminalText(title)}
      </Text>
      {body && <Text dimColor>{sanitizeTerminalText(body)}</Text>}
      <Text>
        <Text bold>y</Text> {strings.yes} · <Text bold>n</Text> {strings.noDefault}
      </Text>
    </Box>
  )
}
