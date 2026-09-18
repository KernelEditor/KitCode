const MENTION_PATTERN = /(?:^|\s)@([^\s@]+)/g
const TRAILING_PUNCTUATION = /[,;:!?]+$/

export interface MentionSpan {
  start: number
  end: number
  query: string
}

// The token under the cursor counts as a mention only when its "@" opens a
// word: an email address or a decorator in pasted code must stay plain text.
export function mentionSpan(value: string, cursor: number): MentionSpan | null {
  const at = clamp(cursor, 0, value.length)
  const before = value.slice(0, at)
  const start = before.lastIndexOf('@')
  if (start === -1) return null

  const preceding = start === 0 ? '' : (value[start - 1] ?? '')
  if (preceding !== '' && !/\s/.test(preceding)) return null

  const query = before.slice(start + 1)
  if (/[\s@]/.test(query)) return null

  let end = at
  while (end < value.length && !/[\s@]/.test(value[end] ?? '')) end += 1
  return { start, end, query }
}

export function completeMention(
  value: string,
  span: MentionSpan,
  path: string,
): { value: string; cursor: number } {
  const rest = value.slice(span.end)
  // Land the cursor past a single separating space without doubling one that
  // the line already has.
  const spaced = rest.startsWith(' ')
  const inserted = `@${path}${spaced ? '' : ' '}`
  return {
    value: value.slice(0, span.start) + inserted + rest,
    cursor: span.start + inserted.length + (spaced ? 1 : 0),
  }
}

export function extractMentions(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const path = (match[1] ?? '').replace(TRAILING_PUNCTUATION, '')
    if (path !== '' && !found.includes(path)) found.push(path)
  }
  return found
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
