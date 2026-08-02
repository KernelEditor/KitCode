import { Box, Text } from 'ink'
import { useMemo } from 'react'
import type { ReactNode } from 'react'

/**
 * Minimal inline + block markdown renderer for the transcript.
 *
 * Supported:
 *  - headings:       "# h1", "## h2", ... "###### h6"
 *  - blockquotes:    "> quote"
 *  - unordered list: "-", "*", "+"
 *  - ordered list:   "1.", "2." ...
 *  - inline:         **bold**, *italic*, `code`, ~~strike~~
 *
 * Everything else is rendered as plain paragraphs, with hard line breaks
 * inside the same paragraph soft-wrapped by ink.
 */

interface MdNode {
  type: 'heading' | 'paragraph' | 'blockquote' | 'ul' | 'ol'
  level?: number
  items?: string[]
  text?: string
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
        <Box marginLeft={2}>
          <Text dimColor>│ {block.text}</Text>
        </Box>
      )
    case 'ul':
      return (
        <Box flexDirection="column">
          {(block.items ?? []).map((item, i) => (
            <Box key={i}>
              <Text dimColor>• </Text>
              <Text>{inline(item)}</Text>
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
              <Text>{inline(item)}</Text>
            </Box>
          ))}
        </Box>
      )
    case 'paragraph':
    default:
      return <Text>{inline(block.text ?? '')}</Text>
  }
}

/** Truncates heading text to roughly `size` chars (esthetic cap, not a hard limit). */
function truncateBySize(text: string, size: number): string {
  return text.length > size * 3 ? text.slice(0, size * 3) + '…' : text
}

/* ---------- block parsing ---------- */

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const UL_RE = /^([-*+])\s+(.*)$/
const OL_RE = /^(\d+)\.\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/

export function extractBlocks(src: string): MdNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdNode[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
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
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      flushAll()
      continue
    }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      flushAll()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }

    const quoteMatch = trimmed.match(QUOTE_RE)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      quote.push(quoteMatch[1])
      continue
    }

    const ulMatch = trimmed.match(UL_RE)
    if (ulMatch) {
      flushParagraph()
      flushQuote()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(ulMatch[2].trim())
      continue
    }

    const olMatch = trimmed.match(OL_RE)
    if (olMatch) {
      flushParagraph()
      flushQuote()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(olMatch[2].trim())
      continue
    }

    // plain text line (continuation of paragraph; list/quote ends)
    flushList()
    flushQuote()
    paragraph.push(trimmed)
  }

  flushAll()
  return blocks
}

/* ---------- inline parsing ---------- */

/**
 * Parses inline markdown into ReactNodes. Supports inline code, bold (star
 * and underscore), italic, and strikethrough. Nested emphasis is
 * intentionally minimal — this targets assistant chat output, not arbitrary MD.
 */
function inline(text: string): ReactNode {
  const nodes: ReactNode[] = []
  let rest = text
  let key = 0

  const RE =
    /(`+)([^`]+?)\1|(\*\*)(.+?)\2|(~~)(.+?)\4|(\*)(.+?)\6|(__)(.+?)\8/

  while (rest.length > 0) {
    const m = rest.match(RE)
    if (!m) {
      nodes.push(rest)
      break
    }
    const idx = m.index ?? 0
    if (idx > 0) nodes.push(rest.slice(0, idx))

    if (m[1]) {
      // `code`
      nodes.push(
        <Text key={key++} bold color="cyan">
          {m[2]}
        </Text>,
      )
    } else if (m[3]) {
      // **bold**
      nodes.push(
        <Text key={key++} bold>
          {inline(m[4] as string)}
        </Text>,
      )
    } else if (m[5]) {
      // ~~strike~~
      nodes.push(
        <Text key={key++} strikethrough>
          {m[6]}
        </Text>,
      )
    } else if (m[7]) {
      // *italic*
      nodes.push(
        <Text key={key++} italic>
          {inline(m[8] as string)}
        </Text>,
      )
    } else if (m[9]) {
      // __bold__
      nodes.push(
        <Text key={key++} bold>
          {inline(m[10] as string)}
        </Text>,
      )
    }

    rest = rest.slice(idx + m[0].length)
  }

  return nodes.length === 1 ? nodes[0] : nodes
}
