import { Box, Text } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { PermissionDecision } from '../../core/types'
import { normalizeHotkey } from '../layout'
import { useTerminalInput } from '../input'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import type { PermissionPromptProps } from '../types'
import { sanitizeTerminalText } from '../sanitize'
import { Diff } from './Diff'

const MAX_PREVIEW_CHARS = 20_000
// Enter pressed within this window was typed before the prompt appeared (for
// example, the end of the user's own message); it must not approve anything.
const ENTER_GRACE_MS = 400

// Commands that delete, overwrite history, escalate or pipe the network into a
// shell. Matching only changes how loudly the prompt warns.
const DANGEROUS = [
  /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/i,
  /\b(?:rmdir|del|erase|rd)\s+\/[sq]/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bgit\s+(?:push\s+.*(?:--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i,
  /\b(?:sudo|doas|runas)\b/i,
  /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(?:sh|bash|zsh|iex|Invoke-Expression|python)/i,
  /\b(?:mkfs|format|diskpart|dd\s+if=)/i,
  /\bchmod\s+(?:-R\s+)?777\b/i,
  />\s*\/dev\/(?:sd|nvme|disk)/i,
  /\bDROP\s+(?:TABLE|DATABASE)\b/i,
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.some((pattern) => pattern.test(command))
}

export function PermissionPrompt({ request, onDecide }: PermissionPromptProps) {
  const theme = useTheme()
  const strings = useStrings()
  const options: { decision: PermissionDecision; label: string; key: string }[] = [
    { decision: 'once', label: strings.allowOnce, key: 'y' },
    ...(request.allowAlways !== false
      ? [{ decision: 'always' as const, label: `${strings.always} (${sanitizeTerminalText(request.toolName)})`, key: 'a' }]
      : []),
    { decision: 'deny', label: strings.deny, key: 'n' },
  ]
  const command = commandOf(request.input)
  const dangerous = command !== undefined && isDangerousCommand(command)
  // A risky command starts on "deny" so a stray Enter cannot run it.
  const [selected, setSelected] = useState(dangerous ? options.length - 1 : 0)
  const shownAt = useRef(Date.now())
  // The same component is reused for back-to-back requests: start each fresh.
  useEffect(() => {
    shownAt.current = Date.now()
    setSelected(dangerous ? options.length - 1 : 0)
  }, [request])

  useTerminalInput((char, key) => {
    const c = normalizeHotkey(char)
    if (key.upArrow) setSelected((index) => (index - 1 + options.length) % options.length)
    else if (key.downArrow || key.tab) setSelected((index) => (index + 1) % options.length)
    else if (key.escape) onDecide('deny')
    else if (key.return) {
      if (Date.now() - shownAt.current >= ENTER_GRACE_MS) onDecide(options[selected]!.decision)
    } else {
      const byKey = options.find((option) => option.key === c)
      if (byKey) onDecide(byKey.decision)
    }
  })

  const frame = dangerous ? theme.error : theme.warn

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={frame} paddingX={1}>
      <Text bold color={frame}>
        {dangerous ? `⚠ ${strings.dangerousCommand} · ` : ''}
        {sanitizeTerminalText(request.summary)}
      </Text>

      {command !== undefined ? (
        <Box marginTop={1}>
          <Text color={dangerous ? theme.error : undefined}>$ {previewText(command, 2_000)}</Text>
        </Box>
      ) : (
        <>
          {request.display?.kind === 'diff' && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>{sanitizeTerminalText(request.display.path)}</Text>
              <Diff before={request.display.before} after={request.display.after} indent={4} />
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
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        {options.map((option, index) => {
          const active = index === selected
          return (
            <Text key={option.decision} color={active ? frame : undefined} bold={active} dimColor={!active}>
              {active ? '❯ ' : '  '}
              {option.label}
              <Text dimColor> ({option.key})</Text>
            </Text>
          )
        })}
        <Text dimColor>{strings.permissionKeys}</Text>
      </Box>
    </Box>
  )
}

function commandOf(input: unknown): string | undefined {
  const command = (input as { command?: unknown } | null | undefined)?.command
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
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
