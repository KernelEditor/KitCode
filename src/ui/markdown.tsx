import { Box, Text } from 'ink'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useTheme } from './theme'

interface MdNode {
  type: 'heading' | 'paragraph' | 'blockquote' | 'ul' | 'ol' | 'table' | 'code' | 'hr'
  level?: number
  items?: MdNode[]
  text?: string
  lang?: string
  headers?: string[]
  rows?: string[][]
  colAligns?: ('left' | 'center' | 'right')[]
  nested?: boolean
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
      const sizes = [22, 20, 18, 16, 14, 13]
      const size = sizes[(block.level ?? 1) - 1] ?? 14
      return (
        <Box marginTop={block.level === 1 ? 1 : 0}>
          <Text bold>{truncateBySize(block.text ?? '', size)}</Text>
        </Box>
      )
    }
    case 'blockquote':
      return (
        <Box flexDirection="column" marginLeft={2}>
          {(block.text ?? '').split('\n').map((line, i) => (
            <Box key={i}>
              <Text dimColor>│ </Text>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
        </Box>
      )
    case 'ul':
      return (
        <Box flexDirection="column">
          {(block.items ?? []).map((item, i) => (
            <Box key={i}>
              <Text dimColor>• </Text>
              <Box marginLeft={2}>
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
              <Text dimColor>{`${i + 1}. `}</Text>
              <Box marginLeft={2}>
                <BlockView block={item} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    case 'paragraph':
    default:
      return <Text>{inline(block.text ?? '')}</Text>
    case 'table':
      return <TableView block={block} />
    case 'code':
      return <CodeBlock lang={block.lang} code={block.text ?? ''} />
    case 'hr':
      return (
        <Box marginTop={1} marginBottom={1}>
          <Text dimColor>{'─'.repeat(60)}</Text>
        </Box>
      )
  }
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const theme = useTheme()
  const lines = code.split('\n')

  return (
    <Box flexDirection="column" marginTop={1}>
      {lang && (
        <Text dimColor color={theme.accent}>
          {lang}
        </Text>
      )}
      <Box borderColor="gray" borderStyle="round" paddingX={1}>
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

function TableView({ block }: { block: MdNode }) {
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
  const colWidths = new Array(colCount).fill(0)

  const allRows = [headers, ...rows]
  for (const row of allRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      colWidths[i] = Math.max(colWidths[i], [...cell].length)
    }
  }

  // Build separator: ───┼───┼───
  const separator = colWidths.map((w) => '─'.repeat(w)).join('┼')

  const lines: ReactNode[] = []
  allRows.forEach((row, rowIdx) => {
    const cells = []
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? ''
      const align = block.colAligns?.[i] ?? 'left'
      const visualWidth = [...cell].length
      const padWidth = colWidths[i] + (cell.length - visualWidth)
      let padded: string
      if (align === 'right') {
        padded = cell.padStart(padWidth)
      } else if (align === 'center') {
        const totalPad = padWidth - visualWidth
        const left = Math.floor(totalPad / 2)
        padded = ' '.repeat(left) + cell + ' '.repeat(totalPad - left)
      } else {
        padded = cell.padEnd(padWidth)
      }
      cells.push(padded)
    }
    lines.push(
      <Text key={`row-${rowIdx}`} bold={rowIdx === 0}>
        {cells.join(' │ ')}
      </Text>,
    )
    if (rowIdx === 0) {
      lines.push(<Text key={`sep-${rowIdx}`} dimColor>{separator}</Text>)
    }
  })

  return <Box flexDirection="column">{lines}</Box>
}

// Maximum characters per font size level (1-6)
const CHARS_PER_FONT_LEVEL = 3

function truncateBySize(text: string, size: number): string {
  const maxLen = size * CHARS_PER_FONT_LEVEL
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const UL_RE = /^([-*+])\s+(.*)$/
const OL_RE = /^(\d+)\.\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const TASK_RE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/
const INDENT_RE = /^(\s*)(.*)$/
const HR_RE = /^([-*_])\1{2,}$/
const FENCE_RE = /^(`{3,}|~{3,})(\w*)\s*$/

export function extractBlocks(src: string): MdNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdNode[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: MdNode[]; indent: number } | null = null
  let quote: string[] = []
  let code: { fence: string; lang: string; lines: string[] } | null = null
  let table: { headers: string[]; rows: string[][]; colAligns: ('left' | 'center' | 'right')[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
      paragraph = []
    }
  }
  const flushList = () => {
    if (list && list.items.length) {
      blocks.push({ type: list.ordered ? 'ol' : 'ul', items: list.items })
      list = null
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
    flushList()
    flushQuote()
    flushCode()
  }

  const flushTable = () => {
    if (table && table.headers.length > 0) {
      blocks.push({
        type: 'table',
        headers: table.headers,
        rows: table.rows,
        colAligns: table.colAligns,
      })
    }
    table = null
  }

  const parseListItem = (text: string, indent: number): MdNode => {
    const task = text.match(TASK_RE)
    if (task) {
      const done = task[1].toLowerCase() === 'x'
      return {
        type: 'paragraph',
        text: `${done ? '☑' : '☐'} ${task[2]}`,
      }
    }
    return { type: 'paragraph', text }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (code) {
      const endMatch = trimmed.match(FENCE_RE)
      if (endMatch && endMatch[1][0] === code.fence[0] && endMatch[1].length >= code.fence.length) {
        flushCode()
        continue
      }
      code.lines.push(line)
      continue
    }

    const fenceMatch = trimmed.match(FENCE_RE)
    if (fenceMatch) {
      flushAll()
      flushTable()
      code = { fence: fenceMatch[1], lang: fenceMatch[2], lines: [] }
      continue
    }

    if (trimmed === '') {
      flushTable()
      flushAll()
      continue
    }

    const hrMatch = trimmed.match(HR_RE)
    if (hrMatch) {
      flushTable()
      flushAll()
      blocks.push({ type: 'hr' })
      continue
    }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      flushTable()
      flushAll()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }

    const quoteMatch = trimmed.match(QUOTE_RE)
    if (quoteMatch) {
      flushTable()
      flushParagraph()
      flushList()
      flushCode()
      quote.push(quoteMatch[1])
      continue
    }

    const indentMatch = line.match(INDENT_RE)
    const indent = indentMatch?.[1].length ?? 0

    const taskMatch = trimmed.match(TASK_RE)
    if (taskMatch) {
      flushTable()
      flushParagraph()
      flushQuote()
      flushCode()
      if (!list || list.ordered || indent !== list.indent) {
        flushList()
        list = { ordered: false, items: [], indent }
      }
      list.items.push(parseListItem(trimmed, indent))
      continue
    }

    const ulMatch = trimmed.match(UL_RE)
    if (ulMatch) {
      flushTable()
      flushParagraph()
      flushQuote()
      flushCode()
      if (!list || list.ordered || indent !== list.indent) {
        flushList()
        list = { ordered: false, items: [], indent }
      }
      list.items.push(parseListItem(ulMatch[2], indent))
      continue
    }

    const olMatch = trimmed.match(OL_RE)
    if (olMatch) {
      flushTable()
      flushParagraph()
      flushQuote()
      flushCode()
      if (!list || !list.ordered || indent !== list.indent) {
        flushList()
        list = { ordered: true, items: [], indent }
      }
      list.items.push(parseListItem(olMatch[2], indent))
      continue
    }

    // Table separator row: must contain at least one | and have 2+ columns of :--- format
    const sepMatch = trimmed.match(/^\|?\s*(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/)
    if (sepMatch) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
      if (cells.length >= 2 && cells.every((c) => /^:?-+:?$/.test(c))) {
        if (table) {
          table.colAligns = cells.map((c) => {
            if (c.startsWith(':') && c.endsWith(':')) return 'center'
            if (c.endsWith(':')) return 'right'
            return 'left'
          })
          continue
        }
      }
    }

    // Table row: must have at least one | with non-empty content on both sides
    // This prevents matching code like `if (x || y)` or paths with |
    const rowMatch = trimmed.match(/^\|?.+\|.+\|?$/)
    if (rowMatch) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter((c, idx, arr) => {
        if (idx === 0 && c === '') return false
        if (idx === arr.length - 1 && c === '') return false
        return true
      })
      // Reject Windows paths like C:\path|other or \\server\share|file and single-cell rows
      const isWindowsPath =
        cells.length === 2 &&
        (/^[A-Za-z]:\\/.test(cells[0]) || /^\\\\/.test(cells[0]))
      if (cells.length >= 2 && cells.every((c) => c.length > 0) && !isWindowsPath) {
        if (table) {
          table.rows.push(cells)
        } else {
          flushAll()
          table = { headers: cells, rows: [], colAligns: [] }
        }
        continue
      }
    }

    // ASCII table separator: line of ─ or - (for tables without pipe borders)
    // Only match if it looks like a table separator (multiple dashes with optional spaces)
    const asciiSepMatch = trimmed.match(/^[\s\-─┄┈━┅]{3,}$/)
    if (asciiSepMatch) {
      if (table && table.headers.length > 0 && table.colAligns.length === 0) {
        // Infer left alignment for all columns
        table.colAligns = table.headers.map(() => 'left')
        continue
      }
      // Check if previous paragraph looks like table headers (2+ space-separated tokens)
      // Must check BEFORE flushAll() clears paragraph
      if (paragraph.length === 1) {
        const prevLine = paragraph[0].trim()
        const tokens = prevLine.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0)
        if (tokens.length >= 2 && tokens.length <= 10) {
          // Looks like ASCII table headers — convert paragraph to table
          paragraph = []
          flushList()
          flushQuote()
          flushCode()
          table = { headers: tokens, rows: [], colAligns: tokens.map(() => 'left') }
          continue
        }
      }
    }

    // ASCII table row without pipes: space-separated columns
    // Only match if we already have a table context (headers parsed)
    // Split by 2+ spaces to avoid splitting paths and code
    if (table && table.headers.length > 0 && !trimmed.includes('|')) {
      const tokens = trimmed.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0)
      // Must have similar number of columns as headers (allow some flexibility)
      if (tokens.length >= 2 && tokens.length <= table.headers.length + 2) {
        // Don't match if it looks like code or a path
        const looksLikeCode = tokens.some((t) => t.startsWith('//') || t.startsWith('#') || t.startsWith('/*'))
        const looksLikePath = tokens.length === 2 && (/^[A-Za-z]:\\/.test(tokens[0]) || /^\\\\/.test(tokens[0]))
        if (!looksLikeCode && !looksLikePath) {
          table.rows.push(tokens)
          continue
        }
      }
    }

    flushTable()
    flushList()
    flushQuote()
    flushCode()
    paragraph.push(trimmed)
  }

  flushTable()
  flushAll()
  return blocks
}

// Maximum nesting depth for inline formatting to prevent stack overflow
const MAX_INLINE_DEPTH = 10

function inline(text: string, depth = 0): ReactNode {
  if (depth > MAX_INLINE_DEPTH) {
    return text
  }

  const nodes: ReactNode[] = []
  let rest = text
  let key = 0

  const matchers: Array<{ re: RegExp; handler: (m: RegExpMatchArray) => ReactNode }> = [
    {
      re: /(!\[)([^\]]*)\]\(([^)]+)\)/,
      handler: (m) => (
        <Text key={key++} color="cyan" bold>
          [img: {m[2]}]
        </Text>
      ),
    },
    {
      re: /(\[)([^\]]*)\]\(([^)]+)\)/,
      handler: (m) => (
        <>
          <Text key={key++} color="cyan" underline>
            {inline(m[2] as string, depth + 1)}
          </Text>
          <Text key={key++} dimColor color="gray">
            ({m[3]})
          </Text>
        </>
      ),
    },
    {
      re: /(`+)([^`]+?)\1/,
      handler: (m) => (
        <Text key={key++} bold color="cyan">
          {m[2]}
        </Text>
      ),
    },
    {
      re: /(\*\*)(.+?)\1/,
      handler: (m) => (
        <Text key={key++} bold>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(__)(.+?)\1/,
      handler: (m) => (
        <Text key={key++} bold>
          {inline(m[2], depth + 1)}
        </Text>
      ),
    },
    {
      re: /(~~)(.+?)\1/,
      handler: (m) => (
        <Text key={key++} strikethrough>
          {m[2]}
        </Text>
      ),
    },
    {
      re: /(\*)(.+?)\1/,
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
      nodes.push(rest)
      break
    }

    const idx = best.match.index ?? 0
    if (idx > 0) nodes.push(rest.slice(0, idx))
    nodes.push(best.handler(best.match))
    rest = rest.slice(idx + best.match[0].length)
  }

  return nodes.length === 1 ? nodes[0] : nodes
}
