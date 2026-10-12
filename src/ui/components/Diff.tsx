import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import { canRenderDiff, diffLines, MAX_RENDER_DIFF_CHARS, type DiffLine } from '../diff'
import { sanitizeTerminalText } from '../sanitize'
import { useTerminalSize } from '../terminal-size'

// Muted backgrounds for whole changed lines, brighter ones for the exact span
// that changed inside a line.
const STYLE = {
  add: { sign: '+', fg: '#86efac', bg: '#173822', strong: '#2c6a40' },
  del: { sign: '-', fg: '#fca5a5', bg: '#3f1c1c', strong: '#83302d' },
} as const

export function Diff({ before, after, indent }: { before: string; after: string; indent?: number }) {
  if (!canRenderDiff(before, after)) {
    return (
      <Text dimColor>
        Diff preview omitted: it exceeds {MAX_RENDER_DIFF_CHARS.toLocaleString()} characters.
      </Text>
    )
  }
  const { hunk, hidden } = diffLines(sanitizeTerminalText(before), sanitizeTerminalText(after))
  return <DiffHunk lines={hunk} hidden={hidden} indent={indent} />
}

export function DiffHunk({ lines, hidden, indent = 2 }: { lines: DiffLine[]; hidden: number; indent?: number }) {
  const { columns } = useTerminalSize()
  const gutter = Math.max(1, ...lines.map((line) => String(line.line ?? '').length))
  // gutter + space + sign + space, and one spare column so a full-width line
  // never wraps onto the next row.
  const width = Math.max(10, (Number.isFinite(columns) ? columns : 80) - indent - gutter - 4)

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const text = sanitizeTerminalText(line.text).replace(/\t/g, '  ').replace(/\r$/, '')
        const number = String(line.line ?? '').padStart(gutter)
        if (line.kind === 'ctx') {
          return (
            <Text key={index} dimColor>
              {number}   {clip(text, width)}
            </Text>
          )
        }
        const style = STYLE[line.kind]
        const shown = clip(text, width)
        // Span offsets index the raw line; skip them when tabs or clipping moved the text.
        const span = line.changed && shown === text && text === line.text ? line.changed : undefined
        // The background lives on a Box so it fills whatever width the
        // container has, instead of padding text to a guessed terminal width.
        return (
          <Box key={index}>
            <Text dimColor>{number} </Text>
            <Box flexGrow={1} backgroundColor={style.bg}>
              <Text color={style.fg} wrap="truncate-end">
                {style.sign}{' '}
                {span ? (
                  <>
                    {shown.slice(0, span[0])}
                    <Text backgroundColor={style.strong} bold>{shown.slice(span[0], span[1])}</Text>
                    {shown.slice(span[1])}
                  </>
                ) : shown}
              </Text>
            </Box>
          </Box>
        )
      })}
      {hidden > 0 && <Text dimColor>{' '.repeat(gutter)}   … {hidden} more lines</Text>}
    </Box>
  )
}

function clip(text: string, width: number): string {
  if (stringWidth(text) <= width) return text
  let out = ''
  for (const character of text) {
    if (stringWidth(out + character) > width - 1) break
    out += character
  }
  return `${out}…`
}
