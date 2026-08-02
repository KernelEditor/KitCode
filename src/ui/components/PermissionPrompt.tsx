import { Box, Text } from 'ink'
import { normalizeHotkey } from '../layout'
import { useTerminalInput } from '../input'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import type { PermissionPromptProps } from '../types'
import { sanitizeTerminalText } from '../sanitize'
import { Diff } from './Diff'

const MAX_PREVIEW_CHARS = 20_000

export function PermissionPrompt({ request, onDecide }: PermissionPromptProps) {
  const theme = useTheme()
  const strings = useStrings()
  useTerminalInput((char, key) => {
    const c = normalizeHotkey(char)
    if (c === 'y') onDecide('once')
    else if (c === 'a' && request.allowAlways !== false) onDecide('always')
    else if (c === 'n' || key.escape || key.return) onDecide('deny')
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text bold color={theme.warn}>
        {sanitizeTerminalText(request.summary)}
      </Text>

      {request.display?.kind === 'diff' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{sanitizeTerminalText(request.display.path)}</Text>
          <Diff before={request.display.before} after={request.display.after} />
        </Box>
      )}

      {request.display?.kind === 'text' && (
        <Text dimColor>{previewText(request.display.text)}</Text>
      )}

      {request.display?.kind === 'list' && (
        <Box flexDirection="column">
          <Text dimColor>{sanitizeTerminalText(request.display.title)}</Text>
          {request.display.items.slice(0, 100).map((item, index) => (
            <Text key={index} dimColor>• {previewText(item, 1_000)}</Text>
          ))}
        </Box>
      )}

      {!request.display && <Text dimColor>{printInput(request.input)}</Text>}

      <Box marginTop={1}>
        <Text>
          <Text bold>y</Text> {strings.allowOnce} ·{' '}
          {request.allowAlways !== false && (
            <><Text bold>a</Text> {strings.always} ({sanitizeTerminalText(request.toolName)}) · </>
          )}
          <Text bold>n</Text> {strings.deny}
        </Text>
      </Box>
    </Box>
  )
}

function printInput(input: unknown): string {
  try {
    return previewText(JSON.stringify(input, null, 2))
  } catch {
    return previewText(input)
  }
}

function previewText(value: unknown, limit = MAX_PREVIEW_CHARS): string {
  const safe = sanitizeTerminalText(value)
  return safe.length > limit ? `${safe.slice(0, limit)}\n... preview truncated` : safe
}
