import { useTerminalSize } from '../terminal-size'
import { Box, Text } from 'ink'
import type { Key } from 'ink'
import { memo, useEffect, useRef, useState } from 'react'
import { looksLikeAttachmentPath } from '../../core/attachments'
import { matchCommands } from '../commands'
import { completeMention, mentionSpan } from '../mentions'
import { moveInputHistory } from '../history'
import { useStrings } from '../i18n'
import { useTerminalInput, useTerminalPaste } from '../input'
import { useTheme } from '../theme'
import { sanitizeTerminalText } from '../sanitize'
import type { PromptInputProps } from '../types'

const WINDOW = 6
const CAT_FRAME_MS = 500
const CAT_FRAMES = [
  '/ᐠ｡ꞈ｡ᐟ\\ ~',
  '/ᐠ｡ꞈ｡ᐟ\\ ∿',
  '/ᐠ｡ꞈ｡ᐟ\\ ~',
  '/ᐠ｡ꞈ｡ᐟ\\ ∾',
  '/ᐠ｡ꞈ｡ᐟ\\ ~',
  '/ᐠ｡ꞈ｡ᐟ\\ ∿',
  '/ᐠ-ꞈ-ᐟ\\ ~',
  '/ᐠ｡ꞈ｡ᐟ\\ ∾',
]
const MAX_INPUT_ROWS = 6

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
  onListFiles,
}: PromptInputProps) {
  const theme = useTheme()
  const { columns, rows } = useTerminalSize()
  const panelWidth = Math.max(2, columns - 1)
  const inputRows = Math.max(1, Math.min(MAX_INPUT_ROWS, rows - 16))
  const strings = useStrings()
  const [catFrame, setCatFrame] = useState(0)
  useEffect(() => {
    if (!disabled) return
    const timer = setInterval(() => setCatFrame((frame) => (frame + 1) % CAT_FRAMES.length), CAT_FRAME_MS)
    return () => clearInterval(timer)
  }, [disabled])
  const panelColor = disabled ? theme.warn : theme.accent
  const fullTitle = disabled ? `KitCode ${CAT_FRAMES[catFrame]}` : 'KitCode'
  const panelTitle = fullTitle.slice(0, Math.max(0, panelWidth - 5))
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

  const commandSuggestions = matchCommands(safeValue)
  const mention = onListFiles ? mentionSpan(safeValue, inputCursor) : null
  const [files, setFiles] = useState<string[]>([])
  const mentionQuery = mention?.query ?? null

  useEffect(() => {
    if (mentionQuery === null || !onListFiles) {
      setFiles([])
      return
    }
    let live = true
    void onListFiles(mentionQuery).then((found) => {
      if (live) setFiles(found)
    })
    return () => {
      live = false
    }
  }, [mentionQuery, onListFiles])

  const showFiles = mention !== null && files.length > 0
  const suggestions = showFiles ? [] : commandSuggestions
  const open = suggestions.length > 0 || showFiles
  const optionCount = showFiles ? files.length : suggestions.length
  const active = Math.min(selectionCursor, Math.max(0, optionCount - 1))

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
      setSelectionCursor(Math.min(optionCount - 1, active + 1))
      return
    }
    if (showFiles && (key.tab || key.return) && !key.shift) {
      const chosen = files[active]
      if (chosen && mention) {
        const completed = completeMention(safeValue, mention, chosen)
        change(completed.value, completed.cursor)
      }
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
  const fileStart = Math.max(0, Math.min(active - WINDOW + 2, files.length - WINDOW))

  return (
    <Box width={panelWidth} maxWidth="100%" flexDirection="column" marginTop={1} flexShrink={0}>
      <Box width="100%" flexShrink={0}>
        <Box flexShrink={0}><Text color={panelColor}>╭</Text></Box>
        <Box flexShrink={1} minWidth={0}>
          <Text color={panelColor} wrap="truncate-end">─ {panelTitle} </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} height={1}
          borderStyle="single" borderColor={panelColor}
          borderTop={false} borderBottom borderLeft={false} borderRight={false}
        />
        <Box flexShrink={0}><Text color={panelColor}>╮</Text></Box>
      </Box>
      <Box width="100%" paddingX={1} maxHeight={inputRows} overflowY="hidden">
        <Text color={panelColor}>› </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <EditableText value={safeValue} cursor={inputCursor} placeholder={strings.placeholder} />
        </Box>
        {pending && pending > 0 ? <Text dimColor> · {strings.queued(pending)}</Text> : null}
      </Box>

      {attachments.length > 0 && (
        <Text dimColor>
          {'  '}📎 {attachments.map(sanitizeTerminalText).join(' · ')}
        </Text>
      )}

      <Box width="100%" flexShrink={0}>
        <Box flexShrink={0}><Text color={panelColor}>╰</Text></Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} height={1}
          borderStyle="single" borderColor={panelColor}
          borderTop={false} borderBottom borderLeft={false} borderRight={false}
        />
        <Box flexShrink={0}><Text color={panelColor}>╯</Text></Box>
      </Box>
      {disabled && hint && <Text color={theme.accent}>  {sanitizeTerminalText(hint)}</Text>}

      {showFiles && (
        <Box flexDirection="column" marginLeft={2}>
          {files.slice(fileStart, fileStart + WINDOW).map((file, index) => {
            const selected = fileStart + index === active
            return (
              <Text key={file} color={selected ? theme.accent : undefined} dimColor={!selected}>
                {selected ? '❯ ' : '  '}@{sanitizeTerminalText(file)}
              </Text>
            )
          })}
          {files.length > WINDOW && <Text dimColor>{strings.more(files.length - WINDOW)}</Text>}
          <Text dimColor>{strings.suggestHelp}</Text>
        </Box>
      )}

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
