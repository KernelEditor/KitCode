import { Box, Text } from 'ink'
import type { Key } from 'ink'
import { memo, useEffect, useRef, useState } from 'react'
import { looksLikeAttachmentPath } from '../../core/attachments'
import { matchCommands } from '../commands'
import { moveInputHistory } from '../history'
import { useStrings } from '../i18n'
import { useTerminalInput, useTerminalPaste } from '../input'
import { useTheme } from '../theme'
import { sanitizeTerminalText } from '../sanitize'
import type { PromptInputProps } from '../types'

const WINDOW = 6

export const PromptInput = memo(function PromptInput({
  value,
  onChange,
  onSubmit,
  onPastePath,
  onPasteImage,
  disabled,
  pending,
  hint,
  history,
  attachments = [],
}: PromptInputProps) {
  const theme = useTheme()
  const strings = useStrings()
  const safeValue = sanitizeTerminalText(value)
  const [selectionCursor, setSelectionCursor] = useState(0)
  const [inputCursor, setInputCursor] = useState(() => characters(safeValue).length)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const historyDraft = useRef('')
  const pendingValue = useRef<string | null>(null)
  const valueRef = useRef(safeValue)
  const cursorRef = useRef(inputCursor)
  valueRef.current = safeValue
  cursorRef.current = inputCursor

  const suggestions = matchCommands(safeValue)
  const open = suggestions.length > 0
  const active = Math.min(selectionCursor, Math.max(0, suggestions.length - 1))

  useEffect(() => {
    setSelectionCursor(0)
  }, [safeValue])

  useEffect(() => {
    const length = characters(safeValue).length
    if (pendingValue.current === safeValue) {
      pendingValue.current = null
      setInputCursor((cursor) => clamp(cursor, 0, length))
      return
    }
    // Values inserted by a picker or cleared by the parent are external to
    // this input, so place the cursor at their end.
    setInputCursor(length)
  }, [safeValue])

  const change = (next: string, cursor = characters(next).length) => {
    next = sanitizeTerminalText(next)
    const nextCursor = clamp(cursor, 0, characters(next).length)
    pendingValue.current = next
    valueRef.current = next
    cursorRef.current = nextCursor
    setInputCursor(nextCursor)
    setHistoryIndex(null)
    historyDraft.current = next
    onChange(next)
  }

  const submit = (next: string) => {
    setHistoryIndex(null)
    historyDraft.current = ''
    onSubmit(next)
  }

  const insertPastedText = (pasted: string) => {
    const inserted = characters(sanitizeTerminalText(pasted))
    if (inserted.length === 0) return
    const valueCharacters = characters(valueRef.current)
    const cursor = clamp(cursorRef.current, 0, valueCharacters.length)
    valueCharacters.splice(cursor, 0, ...inserted)
    change(valueCharacters.join(''), cursor + inserted.length)
  }

  useTerminalPaste((pasted) => {
    const safePaste = sanitizeTerminalText(pasted)
    if (onPastePath && looksLikeAttachmentPath(safePaste)) {
      void onPastePath(safePaste).then((consumed) => {
        if (!consumed) insertPastedText(safePaste)
      })
      return
    }
    insertPastedText(safePaste)
  })

  useTerminalInput((input, key) => {
    if (
      onPasteImage &&
      (key.ctrl || key.meta || key.super) &&
      (input.toLowerCase() === 'v' || input === '\u0016')
    ) {
      onPasteImage()
      return
    }
    if (open && key.upArrow) {
      setSelectionCursor(Math.max(0, active - 1))
      return
    }
    if (open && key.downArrow) {
      setSelectionCursor(Math.min(suggestions.length - 1, active + 1))
      return
    }
    if (open && key.tab && !key.shift) {
      const chosen = suggestions[active]
      if (chosen) change(`/${chosen.name} `)
      return
    }
    if (open && key.return) {
      const chosen = suggestions[active]
      if (chosen) submit(`/${chosen.name}`)
      return
    }

    if (!open && (key.upArrow || key.downArrow)) {
      const moved = moveInputHistory(
        history,
        historyIndex,
        safeValue,
        historyDraft.current,
        key.upArrow ? 'previous' : 'next',
      )
      historyDraft.current = moved.draft
      setHistoryIndex(moved.index)
      setInputCursor(characters(moved.value).length)
      if (moved.value !== safeValue) {
        pendingValue.current = moved.value
        onChange(moved.value)
      }
      return
    }

    if (key.tab || key.upArrow || key.downArrow || key.escape || key.pageUp || key.pageDown) {
      return
    }
    if (key.return) {
      submit(safeValue)
      return
    }

    const valueCharacters = characters(safeValue)
    const cursor = clamp(inputCursor, 0, valueCharacters.length)
    if (key.leftArrow || key.rightArrow || key.home || key.end) {
      setInputCursor(nextCursor(cursor, valueCharacters.length, key))
      return
    }
    if (key.backspace) {
      if (cursor > 0) {
        valueCharacters.splice(cursor - 1, 1)
        change(valueCharacters.join(''), cursor - 1)
      }
      return
    }
    if (key.delete) {
      if (cursor < valueCharacters.length) {
        valueCharacters.splice(cursor, 1)
        change(valueCharacters.join(''), cursor)
      }
      return
    }
    if (input === '' || key.ctrl || key.meta) return

    const inserted = characters(sanitizeTerminalText(input))
    if (inserted.length === 0) return
    valueCharacters.splice(cursor, 0, ...inserted)
    change(valueCharacters.join(''), cursor + inserted.length)
  })

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
        <EditableText value={safeValue} cursor={inputCursor} placeholder={strings.placeholder} />
        {pending && pending > 0 ? <Text dimColor> · {strings.queued(pending)}</Text> : null}
      </Box>

      {attachments.length > 0 && (
        <Text dimColor>
          {'  '}📎 {attachments.map(sanitizeTerminalText).join(' · ')}
        </Text>
      )}

      {disabled && hint && <Text dimColor>  {sanitizeTerminalText(hint)}</Text>}

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

function EditableText({
  value,
  cursor,
  placeholder,
}: {
  value: string
  cursor: number
  placeholder: string
}) {
  const valueCharacters = characters(value)
  const at = clamp(cursor, 0, valueCharacters.length)
  if (valueCharacters.length === 0) {
    const placeholderCharacters = characters(sanitizeTerminalText(placeholder))
    return (
      <Text>
        <Text inverse>{placeholderCharacters[0] ?? ' '}</Text>
        <Text color="gray">{placeholderCharacters.slice(1).join('')}</Text>
      </Text>
    )
  }

  return (
    <Text>
      {valueCharacters.slice(0, at).join('')}
      <Text inverse>{valueCharacters[at] ?? ' '}</Text>
      {valueCharacters.slice(at + 1).join('')}
    </Text>
  )
}

function nextCursor(cursor: number, length: number, key: Key): number {
  if (key.home) return 0
  if (key.end) return length
  if (key.leftArrow) return Math.max(0, cursor - 1)
  if (key.rightArrow) return Math.min(length, cursor + 1)
  return cursor
}

function characters(value: string): string[] {
  return [...value]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
