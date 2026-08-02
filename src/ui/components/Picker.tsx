import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { truncate } from '../diff'
import { useStrings } from '../i18n'
import { useTheme } from '../theme'
import { sanitizeTerminalText } from '../sanitize'
import type { PickerProps } from '../types'

const WINDOW = 10

export function Picker({ title, items, onSelect, onCancel }: PickerProps) {
  const theme = useTheme()
  const strings = useStrings()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => {
    const needle = query.toLowerCase()
    if (needle === '') return items
    return items.filter((item) =>
      `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(needle),
    )
  }, [items, query])

  const active = Math.min(cursor, Math.max(0, matches.length - 1))

  useInput((char, key) => {
    if (key.escape) return onCancel()
    if (key.return) {
      const chosen = matches[active]
      return chosen ? onSelect(chosen.key) : onCancel()
    }
    if (key.upArrow) return setCursor(Math.max(0, active - 1))
    if (key.downArrow) return setCursor(Math.min(matches.length - 1, active + 1))
    if (key.backspace || key.delete) {
      setCursor(0)
      return setQuery((q) => q.slice(0, -1))
    }
    if (char && !key.ctrl && !key.meta) {
      setCursor(0)
      setQuery((q) => sanitizeTerminalText(q + char))
    }
  })

  const start = Math.max(0, Math.min(active - WINDOW + 2, matches.length - WINDOW))
  const visible = matches.slice(start, start + WINDOW)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {sanitizeTerminalText(title)}
        {query !== '' && <Text dimColor> / {sanitizeTerminalText(query)}</Text>}
      </Text>

      {matches.length === 0 ? (
        <Text dimColor>{strings.noMatches}</Text>
      ) : (
        visible.map((item, index) => {
          const selected = start + index === active
          return (
            <Text key={item.key} color={selected ? theme.accent : undefined} inverse={selected}>
              {truncate(sanitizeTerminalText(item.label), 70)}
              {item.hint && (
                <Text dimColor> {truncate(sanitizeTerminalText(item.hint), 34)}</Text>
              )}
            </Text>
          )
        })
      )}

      <Text dimColor>
        {strings.pickerHelp(matches.length, items.length)}
      </Text>
    </Box>
  )
}
