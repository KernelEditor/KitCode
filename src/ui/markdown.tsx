import { Box, Text, useWindowSize } from 'ink'
import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import stringWidth from 'string-width'

interface MdNode {
  type: 'heading' | 'paragraph' | 'blockquote' | 'ul' | 'ol' | 'table' | 'code' | 'hr'
  level?: number
  items?: MdNode[]
  text?: string
  lang?: string
  headers?: string[]
  rows?: string[][]
  colAligns?: ('left' | 'center' | 'right')[]
  start?: number
  children?: MdNode[]
}

export function Markdown({ children }: { children: string }): ReactNode {
  const blocks = useMemo(() => extractBlocks(children), [children])
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </Box>
  )
}

function BlockView({ block }: { block: MdNode }): ReactNode {
  switch (block.type) {
    case 'heading': {
      return (
        <Box marginTop={block.level === 1 ? 1 : 0}>
          <Text bold>{inline(block.text ?? '')}</Text>
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box flexDirection="column">
          {(block.text ?? '').split('\n').map((line, i) => (
            <Text key={i} dimColor italic>
              {inline(line)}
            </Text>
          ))}
        </Box>
      )
    case 'ul':
      return (
        <Box flexDirection="column">
          {(block.items ?? []).map((item, i) => (
            <Box key={i}>
              <Text dimColor>{item.text?.match(/^[☑☐] /) ? '' : '• '}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <BlockView block={item} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    case 'ol':
      return (
        <Box flexDirection="column">
          {(block.items ?? []).map((item, i) => (
            <Box key={i}>
              <Text dimColor>{`${(block.start ?? 1) + i}. `}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <BlockView block={item} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    case 'paragraph':
    default: {
      const content = <Text>{inline(block.text ?? '')}</Text>
      if (!block.children?.length) return content
      return (
        <Box flexDirection="column">
          {content}
          <Box flexDirection="column">
            {block.children.map((child, index) => (
              <BlockView key={index} block={child} />
            ))}
          </Box>
        </Box>
      )
    }
    case 'table':
      return <TableView block={block} />
    case 'code':
      return <CodeBlock code={block.text ?? ''} />
    case 'hr':
      return (
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor wrap="truncate-end">{'─'.repeat(60)}</Text>
        </Box>
      )
  }
}

function CodeBlock({ code }: { code: string }) {
  const lines = code.split('\n')

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Text key={i} color="cyan">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function TableView({ block }: { block: MdNode }) {
  const { columns } = useWindowSize()
  const headers = block.headers ?? []
  const rows = block.rows ?? []

  // Guard against malformed table data
  if (headers.length === 0 && rows.length === 0) {
    return <Text dimColor>(empty table)</Text>
  }

  const colCount = Math.max(headers.length, ...rows.map((r) => r?.length ?? 0))
  if (colCount === 0) {
    return <Text dimColor>(empty table)</Text>
  }
  const allRows = [headers, ...rows].map((row) =>
    Array.from({ length: colCount }, (_, index) => inlineDisplayText(row[index] ?? '')),
  )
  const naturalWidths = new Array<number>(colCount).fill(1)
  for (const row of allRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      naturalWidths[i] = Math.max(naturalWidths[i] ?? 1, stringWidth(cell))
    }
  }
  const colWidths = fitColumnWidths(naturalWidths, Math.max(1, columns))

  // Row separators include a space on either side of each vertical bar. Make
  // the junctions land in the same terminal columns as those bars.
  const separator = colWidths
    .map((width, index) => {
      const edge = index === 0 || index === colWidths.length - 1
      return '─'.repeat(width + (edge ? 1 : 2))
    })
    .join('┼')

  const lines: ReactNode[] = []
  allRows.forEach((row, rowIdx) => {
    const cells = []
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      const align = block.colAligns?.[i] ?? 'left'
      const width = colWidths[i] ?? 1
      const fitted = truncateToWidth(cell, width)
      const visualWidth = stringWidth(fitted)
      const totalPad = Math.max(0, width - visualWidth)
      let padded: string
      if (align === 'right') {
        padded = `${' '.repeat(totalPad)}${fitted}`
      } else if (align === 'center') {
        const left = Math.floor(totalPad / 2)
        padded = `${' '.repeat(left)}${fitted}${' '.repeat(totalPad - left)}`
      } else {
        padded = `${fitted}${' '.repeat(totalPad)}`
      }
      cells.push(padded)
    }
    lines.push(
      <Text key={`row-${rowIdx}`} bold={rowIdx === 0} wrap="truncate-end">
        {cells.join(' │ ')}
      </Text>,
    )
    if (rowIdx === 0) {
      lines.push(<Text key={`sep-${rowIdx}`} dimColor wrap="truncate-end">{separator}</Text>)
    }
  })

  return <Box flexDirection="column">{lines}</Box>
}

function fitColumnWidths(natural: number[], maxLineWidth: number): number[] {
  const widths = natural.map((width) => Math.max(1, width))
  const separatorWidth = Math.max(0, widths.length - 1) * 3
  const available = Math.max(widths.length, maxLineWidth - separatorWidth)
  let excess = widths.reduce((sum, width) => sum + width, 0) - available

  while (excess > 0) {
    const shrinkable = widths
      .map((width, index) => ({ width, index }))
      .filter(({ width }) => width > 1)
    if (shrinkable.length === 0) break
    const share = Math.max(1, Math.ceil(excess / shrinkable.length))
    for (const { index } of shrinkable) {
      const current = widths[index] ?? 1
      const amount = Math.min(current - 1, share, excess)
      widths[index] = current - amount
      excess -= amount
      if (excess === 0) break
    }
  }
  return widths
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  let result = ''
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (stringWidth(result + segment) > maxWidth - 1) break
    result += segment
  }
  return `${result}…`
}

function inlineDisplayText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '[$1]')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1($2)')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(?=\S)(.*?\S)\1/g, '$2')
    .replace(/(?<!\\)(\*|_)(?=\S)(.*?\S)\1/g, '$2')
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1')
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/
const UL_RE = /^([-*+])\s+(.*)$/
const OL_RE = /^(\d{1,9})[.)]\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const TASK_CONTENT_RE = /^\[([ xX])\]\s+(.*)$/
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/
const MAX_TABLE_COLUMNS = 20
const MAX_LIST_DEPTH = 20

export function extractBlocks(src: string): MdNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdNode[] = []
  let paragraph: string[] = []
  let quote: string[] = []
  let code: { fence: string; lang: string; lines: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: joinParagraphLines(paragraph) })
      paragraph = []
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ type: 'blockquote', text: quote.join('\n') })
      quote = []
    }
  }
  const flushCode = () => {
    if (code) {
      blocks.push({ type: 'code', lang: code.lang, text: code.lines.join('\n') })
      code = null
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushQuote()
    flushCode()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (code) {
      if (isClosingFence(line, code.fence)) {
        flushCode()
        continue
      }
      code.lines.push(line)
      continue
    }

    const fence = parseOpeningFence(line)
    if (fence) {
      flushAll()
      code = { fence: fence.fence, lang: fence.lang, lines: [] }
      continue
    }

    if (trimmed === '') {
      flushAll()
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushAll()
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
      blocks.push({ type: 'heading', level: heading[1].length, text })
      continue
    }

    const setext = lines[i + 1]?.match(SETEXT_RE)
    if (setext && isSetextHeadingText(line)) {
      flushAll()
      blocks.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, text: trimmed })
      i += 1
      continue
    }

    if (isHorizontalRule(trimmed)) {
      flushAll()
      blocks.push({ type: 'hr' })
      continue
    }

    const quoteMatch = trimmed.match(QUOTE_RE)
    if (quoteMatch) {
      flushParagraph()
      flushCode()
      quote.push(quoteMatch[1])
      continue
    }

    const parsedList = parseListBlock(lines, i)
    if (parsedList) {
      flushParagraph()
      flushQuote()
      flushCode()
      blocks.push(parsedList.block)
      i = parsedList.nextIndex - 1
      continue
    }

    const markdownTable = parseMarkdownTable(lines, i)
    if (markdownTable) {
      flushAll()
      blocks.push(markdownTable.block)
      i = markdownTable.nextIndex - 1
      continue
    }

    const asciiTable = parseAsciiTable(lines, i)
    if (asciiTable) {
      flushAll()
      blocks.push(asciiTable.block)
      i = asciiTable.nextIndex - 1
      continue
    }

    if (quote.length > 0) {
      quote.push(trimmed)
      continue
    }

    flushQuote()
    flushCode()
    paragraph.push(paragraphLine(line))
  }

  flushAll()
  return blocks
}

function paragraphLine(line: string): string {
  const hardBreak = /(?: {2,}|\\)$/.test(line)
  const text = line.trim().replace(/\\$/, '')
  return hardBreak ? `${text}\n` : text
}

function joinParagraphLines(lines: string[]): string {
  let result = ''
  for (const line of lines) {
    if (result && !result.endsWith('\n')) result += ' '
    result += line
  }
  return result.trim()
}

interface ListMarker {
  indent: number
  ordered: boolean
  start: number
  text: string
}

function parseListMarker(line: string): ListMarker | null {
  const match = line.match(/^(\s*)(?:(\d{1,9})[.)]|([-+*]))\s+(.*)$/)
  if (!match) return null
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: Boolean(match[2]),
    start: match[2] ? Number.parseInt(match[2], 10) : 1,
    text: match[4],
  }
}

function parseListItem(text: string): MdNode {
  const task = text.match(TASK_CONTENT_RE)
  return {
    type: 'paragraph',
    text: task ? `${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${task[2]}` : text,
  }
}

function parseListBlock(
  lines: string[],
  start: number,
  depth = 0,
): { block: MdNode; nextIndex: number } | null {
  const first = parseListMarker(lines[start] ?? '')
  if (!first) return null
  const items: MdNode[] = []
  let nextIndex = start

  while (nextIndex < lines.length) {
    const marker = parseListMarker(lines[nextIndex] ?? '')
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break
    const item = parseListItem(marker.text)
    nextIndex += 1

    while (nextIndex < lines.length) {
      if ((lines[nextIndex] ?? '').trim() === '') {
        let afterBlank = nextIndex
        while (afterBlank < lines.length && (lines[afterBlank] ?? '').trim() === '') {
          afterBlank += 1
        }
        const followingMarker = parseListMarker(lines[afterBlank] ?? '')
        if (!followingMarker || followingMarker.indent < first.indent) {
          nextIndex = afterBlank
          break
        }
        nextIndex = afterBlank
        if (followingMarker.indent === first.indent) break
      }

      const followingMarker = parseListMarker(lines[nextIndex] ?? '')
      if (followingMarker) {
        if (followingMarker.indent <= first.indent) break
        if (depth >= MAX_LIST_DEPTH) {
          item.text = `${item.text ?? ''} ${followingMarker.text}`.trim()
          nextIndex += 1
          continue
        }
        const nested = parseListBlock(lines, nextIndex, depth + 1)
        if (!nested) break
        item.children ??= []
        item.children.push(nested.block)
        nextIndex = nested.nextIndex
        continue
      }

      if (interruptsList(lines, nextIndex)) break
      const continuation = (lines[nextIndex] ?? '').trim()
      item.text = `${item.text ?? ''} ${continuation}`.trim()
      nextIndex += 1
    }

    items.push(item)
  }

  const block: MdNode = { type: first.ordered ? 'ol' : 'ul', items }
  if (first.ordered && first.start !== 1) block.start = first.start
  return { block, nextIndex }
}

function interruptsList(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  const trimmed = line.trim()
  return Boolean(
    line.match(HEADING_RE) ||
      trimmed.match(QUOTE_RE) ||
      parseOpeningFence(line) ||
      isHorizontalRule(trimmed) ||
      parseMarkdownTable(lines, index) ||
      parseAsciiTable(lines, index),
  )
}

function parseOpeningFence(line: string): { fence: string; lang: string } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  const info = match[2].trim()
  if (match[1][0] === '`' && info.includes('`')) return null
  return { fence: match[1], lang: info.split(/\s+/, 1)[0] ?? '' }
}

function isClosingFence(line: string, opening: string): boolean {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/)
  return Boolean(
    match &&
      match[1][0] === opening[0] &&
      match[1].length >= opening.length,
  )
}

function isHorizontalRule(line: string): boolean {
  return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
}

function isSetextHeadingText(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed !== '' &&
    !HEADING_RE.test(line) &&
    !QUOTE_RE.test(trimmed) &&
    !UL_RE.test(trimmed) &&
    !OL_RE.test(trimmed) &&
    !parseOpeningFence(line)
  )
}

function parseMarkdownTable(
  lines: string[],
  start: number,
): { block: MdNode; nextIndex: number } | null {
  const headers = splitTableRow(lines[start] ?? '')
  const delimiter = splitTableRow(lines[start + 1] ?? '')
  if (
    !headers ||
    !delimiter ||
    headers.length < 2 ||
    headers.length > MAX_TABLE_COLUMNS ||
    delimiter.length !== headers.length ||
    !delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    return null
  }

  const colAligns = delimiter.map((cell): 'left' | 'center' | 'right' => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
    if (cell.endsWith(':')) return 'right'
    return 'left'
  })
  const rows: string[][] = []
  let nextIndex = start + 2
  while (nextIndex < lines.length) {
    const cells = splitTableRow(lines[nextIndex] ?? '')
    if (!cells) break
    rows.push(headers.map((_, index) => cells[index] ?? ''))
    nextIndex += 1
  }
  return {
    block: { type: 'table', headers, rows, colAligns },
    nextIndex,
  }
}

function splitTableRow(line: string): string[] | null {
  const source = line.trim()
  if (!source.includes('|')) return null
  const cells: string[] = []
  let cell = ''
  let codeFenceLength = 0
  let foundSeparator = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (character === '\\' && source[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (character === '`') {
      let end = index + 1
      while (source[end] === '`') end += 1
      const runLength = end - index
      if (codeFenceLength === 0) codeFenceLength = runLength
      else if (codeFenceLength === runLength) codeFenceLength = 0
      cell += source.slice(index, end)
      index = end - 1
      continue
    }
    if (character === '|' && codeFenceLength === 0) {
      foundSeparator = true
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  if (!foundSeparator) return null
  if (cells[0] === '') cells.shift()
  if (cells[cells.length - 1] === '') cells.pop()
  return cells.length >= 2 ? cells : null
}

function parseAsciiTable(
  lines: string[],
  start: number,
): { block: MdNode; nextIndex: number } | null {
  const headers = splitAsciiCells(lines[start] ?? '')
  if (headers.length < 2 || headers.length > MAX_TABLE_COLUMNS) return null
  const separator = (lines[start + 1] ?? '').trim()
  const separatorCells = splitAsciiCells(separator)
  const validSeparator =
    /^[─┄┈━┅-]{3,}$/.test(separator) ||
    (separatorCells.length === headers.length &&
      separatorCells.every((cell) => /^[─┄┈━┅-]{3,}$/.test(cell)))
  if (!validSeparator) return null

  const rows: string[][] = []
  let nextIndex = start + 2
  while (nextIndex < lines.length) {
    const cells = splitAsciiCells(lines[nextIndex] ?? '')
    if (cells.length !== headers.length) break
    rows.push(cells)
    nextIndex += 1
  }
  if (rows.length === 0) return null
  return {
    block: {
      type: 'table',
      headers,
      rows,
      colAligns: headers.map(() => 'left'),
    },
    nextIndex,
  }
}

function splitAsciiCells(line: string): string[] {
  return line.trim().split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean)
}

// Maximum nesting depth for inline formatting to prevent stack overflow
const MAX_INLINE_DEPTH = 10
const INLINE_ESCAPE_BASE = 0xe000
const ESCAPABLE_MARKDOWN = ['\\', '`', '*', '_', '[', ']', '{', '}', '(', ')', '#', '+', '-', '.', '!', '|', '>'] as const

function protectInlineEscapes(text: string): string {
  return text.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, (_match, character: string) => {
    const index = ESCAPABLE_MARKDOWN.indexOf(character as (typeof ESCAPABLE_MARKDOWN)[number])
    return String.fromCodePoint(INLINE_ESCAPE_BASE + index)
  })
}

function restoreInlineEscapes(text: string): string {
  return [...text].map((character) => {
    const index = character.codePointAt(0)! - INLINE_ESCAPE_BASE
    return index >= 0 && index < ESCAPABLE_MARKDOWN.length
      ? ESCAPABLE_MARKDOWN[index]
      : character
  }).join('')
}

function inline(text: string, depth = 0): ReactNode {
  if (depth > MAX_INLINE_DEPTH) {
    return restoreInlineEscapes(text)
  }

  const nodes: ReactNode[] = []
  let rest = protectInlineEscapes(text)
  let key = 0

  const matchers: Array<{ re: RegExp; handler: (m: RegExpMatchArray) => ReactNode }> = [
    {
      re: /(!\[)([^\]]*)\]\(((?:[^()\\]|\\.|\([^()]*\))+?)\)/,
      handler: (m) => (
        <Text key={key++} color="cyan" bold>
          [img: {restoreInlineEscapes(m[2])}]
        </Text>
      ),
    },
    {
      re: /(\[)([^\]]*)\]\(((?:[^()\\]|\\.|\([^()]*\))+?)\)/,
      handler: (m) => {
        const fragmentKey = key++
        return (
          <Fragment key={fragmentKey}>
            <Text color="cyan" underline>
              {inline(m[2] as string, depth + 1)}
            </Text>
            <Text dimColor color="gray">
              ({restoreInlineEscapes(m[3])})
            </Text>
          </Fragment>
        )
      },
    },
    {
      re: /(`+)([^`]+?)\1/,
      handler: (m) => (
        <Text key={key++} bold color="cyan">
          {restoreInlineEscapes(m[2])}
        </Text>
      ),
    },
    {
      re: /(\*\*\*|___)(?=\S)(.*?\S)\1/,
      handler: (m) => (
        <Text key={key++} bold italic>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(\*\*)(?=\S)(.*?\S)\1/,
      handler: (m) => (
        <Text key={key++} bold>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(__)(?=\S)(.*?\S)\1/,
      handler: (m) => (
        <Text key={key++} bold>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(~~)(?=\S)(.*?\S)\1/,
      handler: (m) => (
        <Text key={key++} strikethrough>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(\*)(?=\S)(.*?\S)\1/,
      handler: (m) => (
        <Text key={key++} italic>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(?<!\w)(_)(?=\S)(.*?\S)\1(?!\w)/,
      handler: (m) => (
        <Text key={key++} italic>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
  ]

  while (rest.length > 0) {
    let best: { match: RegExpMatchArray; handler: (m: RegExpMatchArray) => ReactNode } | null = null

    for (const { re, handler } of matchers) {
      const m = rest.match(re)
      if (m && (best === null || (m.index ?? 0) < (best.match.index ?? 0))) {
        best = { match: m, handler }
      }
    }

    if (!best) {
      nodes.push(restoreInlineEscapes(rest))
      break
    }

    const idx = best.match.index ?? 0
    if (idx > 0) nodes.push(restoreInlineEscapes(rest.slice(0, idx)))
    nodes.push(best.handler(best.match))
    rest = rest.slice(idx + best.match[0].length)
  }

  return nodes.length === 1 ? nodes[0] : nodes
}
