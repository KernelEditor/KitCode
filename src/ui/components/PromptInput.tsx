import { useTerminalSize } from '../terminal-size'
import { Box, Text } from 'ink'
import type { Key } from 'ink'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from 'string-width'
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
// Pastes this big collapse into a token in the input (expanded on submit).
const PASTE_COLLAPSE_CHARS = 1_000
const PASTE_COLLAPSE_LINES = 10
const VISIBLE_QUEUED = 3
const MODE_COLORS = { plan: '#60a5fa', accept: '#fbbf24' } as const

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
  mode = 'normal',
  bypass = false,
  queued = [],
  onNavigateQueue,
}: PromptInputProps) {
  const theme = useTheme()
  const { columns } = useTerminalSize()
  const panelWidth = Math.max(2, columns - 1)
  const inputRows = MAX_INPUT_ROWS
  const strings = useStrings()
  const [catFrame, setCatFrame] = useState(0)
  useEffect(() => {
    if (!disabled) return
    const timer = setInterval(() => setCatFrame((frame) => (frame + 1) % CAT_FRAMES.length), CAT_FRAME_MS)
    return () => clearInterval(timer)
  }, [disabled])
  const modeColor = bypass ? theme.error : mode === 'plan' ? MODE_COLORS.plan : mode === 'accept' ? MODE_COLORS.accept : undefined
  const panelColor = disabled ? theme.warn : modeColor ?? theme.accent
  const modeTitle = bypass ? 'BYPASS' : mode !== 'normal' ? strings.modeLabel[mode] ?? mode : ''
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

  const valueChars = useMemo(() => characters(safeValue), [safeValue])
  // Width left for text: paddingX on both sides and the '› ' marker.
  const inputView = valueChars.length === 0
    ? null
    : inputWindow(valueChars, clamp(inputCursor, 0, valueChars.length), panelWidth - 4, inputRows)
  // Where the visible slice of a long prompt sits, e.g. 'строки 34–39 из 80'.
  const position = inputView && inputView.total > inputRows
    ? strings.inputRows(inputView.first + 1, inputView.first + inputView.rows.length, inputView.total)
    : ''
  const footerText = [modeTitle && `${modeTitle} · shift+tab`, position].filter(Boolean).join(' · ')
  const footer = footerText ? `─ ${footerText} ` : ''

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

  // Big pastes live here and show in the input as a short token; submit swaps
  // the full text back in. Keeps typing fast and the prompt readable.
  const pastes = useRef(new Map<number, string>())
  const pasteCounter = useRef(0)

  const submit = (next: string) => {
    setHistoryIndex(null)
    historyDraft.current = ''
    const expanded = expandPastes(next, pastes.current)
    pastes.current = new Map()
    onSubmit(expanded)
  }

  const insertPastedText = (pasted: string) => {
    const inserted = characters(sanitizeTerminalText(pasted))
    if (inserted.length === 0) return
    const valueCharacters = characters(valueRef.current)
    const cursor = clamp(cursorRef.current, 0, valueCharacters.length)
    // concat, not splice(...inserted): spreading a huge paste overflows the stack.
    const next = valueCharacters.slice(0, cursor).concat(inserted, valueCharacters.slice(cursor))
    change(next.join(''), cursor + inserted.length)
  }

  const collapsePaste = (text: string): string => {
    const lines = text.split('\n').length
    if (text.length < PASTE_COLLAPSE_CHARS && lines <= PASTE_COLLAPSE_LINES) return text
    pasteCounter.current += 1
    pastes.current.set(pasteCounter.current, text)
    return strings.pasteToken(pasteCounter.current, lines, text.length)
  }

  useTerminalPaste((pasted) => {
    const safePaste = sanitizeTerminalText(pasted)
    if (onPastePath && looksLikeAttachmentPath(safePaste)) {
      void onPastePath(safePaste).then((consumed) => {
        if (!consumed) insertPastedText(collapsePaste(safePaste))
      })
      return
    }
    insertPastedText(collapsePaste(safePaste))
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

    // While messages wait, ↑/↓ walk the queue (one item taken out to edit at a
    // time) instead of the chat history.
    if (!open && (key.upArrow || key.downArrow) && onNavigateQueue) {
      const next = onNavigateQueue(key.upArrow ? 'previous' : 'next', safeValue)
      if (next !== null) {
        change(next)
        return
      }
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
      {queued.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {queued.slice(0, VISIBLE_QUEUED).map((text, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {'  '}⏳ {sanitizeTerminalText(text).replace(/\s+/g, ' ').trim()}
            </Text>
          ))}
          {queued.length > VISIBLE_QUEUED && (
            <Text dimColor>{'  '}{strings.more(queued.length - VISIBLE_QUEUED)}</Text>
          )}
          <Text dimColor>{'  '}{strings.queueHint}</Text>
        </Box>
      )}
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
      {/* No side borders: they end up in the clipboard when the input is selected. */}
      <Box width="100%" paddingX={1} maxHeight={inputRows} overflowY="hidden">
        <Text color={panelColor} bold>› </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <EditableText window={inputView} placeholder={strings.placeholder} />
        </Box>
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
        {footer && (
          <Box flexShrink={1} minWidth={0}>
            <Text color={panelColor} bold wrap="truncate-start">{footer.slice(0, Math.max(0, panelWidth - 6))}</Text>
          </Box>
        )}
        <Box flexShrink={0}><Text color={panelColor}>{footer ? '─╯' : '╯'}</Text></Box>
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

export interface InputRow {
  text: string
  /** Column of the cursor when it sits on this row. */
  cursor?: number
}

export interface InputWindow {
  rows: InputRow[]
  /** Index of the first shown row, and the total number of visual rows. */
  first: number
  total: number
}

/**
 * Wraps the input into visual rows and keeps only the ones around the cursor.
 * Ink re-lays-out every character it is given on every keystroke, so handing
 * it a 30k-character prompt made each frame take over a second; this way it
 * only ever sees a few short lines.
 */
export function inputWindow(chars: string[], cursor: number, width: number, maxRows: number): InputWindow {
  // One cell stays free so the cursor block at a row's end never wraps.
  const limit = Math.max(1, width - 1)
  const rows: { chars: string[]; start: number }[] = [{ chars: [], start: 0 }]
  let rowWidth = 0
  let cursorRow = -1
  let cursorCol = 0
  for (let index = 0; index <= chars.length; index += 1) {
    const row = rows[rows.length - 1]!
    if (index === cursor) {
      cursorRow = rows.length - 1
      cursorCol = row.chars.length
    }
    if (index === chars.length) break
    const character = chars[index]!
    if (character === '\n') {
      rows.push({ chars: [], start: index + 1 })
      rowWidth = 0
      continue
    }
    const cells = charWidth(character)
    if (rowWidth + cells > limit && row.chars.length > 0) {
      rows.push({ chars: [character], start: index })
      rowWidth = cells
      // The cursor sat right where the row broke: show it on the new row.
      if (cursorRow === rows.length - 2 && cursorCol === row.chars.length) {
        cursorRow = rows.length - 1
        cursorCol = 0
      }
      continue
    }
    row.chars.push(character)
    rowWidth += cells
  }
  if (cursorRow === -1) {
    cursorRow = rows.length - 1
    cursorCol = rows[cursorRow]!.chars.length
  }
  let first = Math.max(0, rows.length - maxRows)
  if (cursorRow < first) first = cursorRow
  if (cursorRow >= first + maxRows) first = cursorRow - maxRows + 1
  return {
    rows: rows.slice(first, first + maxRows).map((row, offset) => ({
      text: row.chars.join(''),
      ...(first + offset === cursorRow ? { cursor: cursorCol } : {}),
    })),
    first,
    total: rows.length,
  }
}

function charWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0
  // Latin, Cyrillic, Greek and the like are one cell; only the rest needs the
  // (comparatively slow) full width lookup.
  if ((code >= 0x20 && code < 0x300) || (code >= 0x370 && code < 0x1100)) return 1
  return stringWidth(character)
}

function EditableText({ window, placeholder }: { window: InputWindow | null; placeholder: string }) {
  if (!window) {
    const placeholderCharacters = characters(sanitizeTerminalText(placeholder))
    return (
      <Text>
        <Text inverse>{placeholderCharacters[0] ?? ' '}</Text>
        <Text color="gray">{placeholderCharacters.slice(1).join('')}</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      {window.rows.map((row, index) => {
        if (row.cursor === undefined) return <Text key={index}>{row.text || ' '}</Text>
        const chars = characters(row.text)
        return (
          <Text key={index}>
            {chars.slice(0, row.cursor).join('')}
            <Text inverse>{chars[row.cursor] ?? ' '}</Text>
            {chars.slice(row.cursor + 1).join('')}
          </Text>
        )
      })}
    </Box>
  )
}

// Matches the tokens made by strings.pasteToken in either language.
const PASTE_TOKEN = /\[(?:paste|вставка) #(\d+)[^\]\n]*\]/g

export function expandPastes(text: string, pastes: Map<number, string>): string {
  if (pastes.size === 0) return text
  return text.replace(PASTE_TOKEN, (token, id: string) => pastes.get(Number(id)) ?? token)
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
