import { Box, Text, useInput } from 'ink'
import { normalizeHotkey } from '../layout'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import type { PermissionPromptProps } from '../types'
import { Diff } from './Diff'

export function PermissionPrompt({ request, onDecide }: PermissionPromptProps) {
  const theme = useTheme()
  const strings = useStrings()
  useInput((char, key) => {
    const c = normalizeHotkey(char)
    if (c === 'y') onDecide('once')
    else if (c === 'a') onDecide('always')
    else if (c === 'n' || key.escape || key.return) onDecide('deny')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text bold color={theme.warn}>
        {request.summary}
      </Text>

      {request.display?.kind === 'diff' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{request.display.path}</Text>
          <Diff before={request.display.before} after={request.display.after} />
        </Box>
      )}

      {request.display?.kind === 'text' && <Text dimColor>{request.display.text}</Text>}

      <Box marginTop={1}>
        <Text>
          <Text bold>y</Text> {strings.allowOnce} · <Text bold>a</Text> {strings.always} (
          {request.toolName}) · <Text bold>n</Text> {strings.deny}
        </Text>
      </Box>
    </Box>
  )
}
