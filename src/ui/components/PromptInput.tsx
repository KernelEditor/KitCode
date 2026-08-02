import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { memo, useEffect, useRef, useState } from 'react'
import { matchCommands } from '../commands'
import { moveInputHistory } from '../history'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import type { PromptInputProps } from '../types'

const WINDOW = 6

export const PromptInput = memo(function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
  pending,
  hint,
  history,
}: PromptInputProps) {
  const theme = useTheme()
  const strings = useStrings()
  const [cursor, setCursor] = useState(0)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const historyDraft = useRef('')

  const suggestions = matchCommands(value)
  const open = suggestions.length > 0
  const active = Math.min(cursor, Math.max(0, suggestions.length - 1))

  useEffect(() => {
    setCursor(0)
  }, [value])

  const change = (next: string) => {
    setHistoryIndex(null)
    historyDraft.current = next
    onChange(next)
  }

  const submit = (next: string) => {
    setHistoryIndex(null)
    historyDraft.current = ''
    onSubmit(next)
  }

  useInput(
    (_char, key) => {
      if (open) {
        if (key.upArrow) return setCursor(Math.max(0, active - 1))
        if (key.downArrow) return setCursor(Math.min(suggestions.length - 1, active + 1))
        if (key.tab && !key.shift) {
          const chosen = suggestions[active]
          if (chosen) change(`/${chosen.name} `)
          return
        }
        if (key.return) {
          const chosen = suggestions[active]
          if (chosen) submit(`/${chosen.name}`)
        }
        return
      }

      const direction = key.upArrow ? 'previous' : key.downArrow ? 'next' : null
      if (!direction) return
      const moved = moveInputHistory(
        history,
        historyIndex,
        value,
        historyDraft.current,
        direction,
      )
      historyDraft.current = moved.draft
      setHistoryIndex(moved.index)
      if (moved.value !== value) onChange(moved.value)
    },
    { isActive: true },
  )

  const start = Math.max(0, Math.min(active - WINDOW + 2, suggestions.length - WINDOW))
  const visible = suggestions.slice(start, start + WINDOW)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        width="100%"
        borderStyle="round"
        borderColor={disabled ? theme.warn : theme.accent}
        borderDimColor={disabled}
        paddingX={1}
      >
        <Text color={disabled ? 'gray' : theme.accent}>› </Text>
        {/* Input stays active while the agent runs; submitted messages queue. */}
        <TextInput
          key={historyIndex === null ? 'draft' : `history-${historyIndex}`}
          value={value}
          onChange={change}
          onSubmit={open ? noop : submit}
          placeholder={strings.placeholder}
        />
        {pending && pending > 0 ? <Text dimColor> · {strings.queued(pending)}</Text> : null}
      </Box>

      {disabled && hint && <Text dimColor>  {hint}</Text>}

      {open && (
        <Box flexDirection="column" marginLeft={2}>
          {visible.map((command, index) => {
            const selected = start + index === active
            return (
              <Text key={command.name} color={selected ? theme.accent : undefined} dimColor={!selected}>
                {selected ? '❯ ' : '  '}/{command.name}
                {command.args ? ` ${command.args}` : ''}
                <Text dimColor> — {strings.cmd[command.name] ?? ''}</Text>
              </Text>
            )
          })}
          {suggestions.length > visible.length && (
            <Text dimColor>{strings.more(suggestions.length - visible.length)}</Text>
          )}
          <Text dimColor>{strings.suggestHelp}</Text>
        </Box>
      )}
    </Box>
  )
})

function noop(): void {}
