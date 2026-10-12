export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  /** 1-based line number in the old file (del, ctx) or the new file (add). */
  line?: number
  /** For a changed line paired with its counterpart: the [start, end) span that differs. */
  changed?: [number, number]
}

export interface DiffResult {
  hunk: DiffLine[]
  hidden: number
  
  added: number
  
  removed: number
}

export const MAX_RENDER_DIFF_CHARS = 500_000

export function canRenderDiff(before: string, after: string): boolean {
  return before.length + after.length <= MAX_RENDER_DIFF_CHARS
}

export function diffLines(
  before: string,
  after: string,
  maxLines = 20,
): DiffResult {
  const { added, removed, hunk } = diffBody(before, after)
  if (hunk.length <= maxLines) return { hunk, hidden: 0, added, removed }
  return { hunk: hunk.slice(0, maxLines), hidden: hunk.length - maxLines, added, removed }
}

export function diffCounts(
  before: string,
  after: string,
): { added: number; removed: number } {
  return diffBody(before, after)
}

function diffBody(
  before: string,
  after: string,
): { added: number; removed: number; hunk: DiffLine[] } {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1

  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const hunk: DiffLine[] = []
  let added = 0
  let removed = 0
  for (let i = Math.max(0, start - 2); i < start; i += 1) {
    hunk.push({ kind: 'ctx', text: a[i] ?? '', line: i + 1 })
  }
  const dels: DiffLine[] = []
  for (let i = start; i < endA; i += 1) {
    dels.push({ kind: 'del', text: a[i] ?? '', line: i + 1 })
    removed += 1
  }
  const adds: DiffLine[] = []
  for (let i = start; i < endB; i += 1) {
    adds.push({ kind: 'add', text: b[i] ?? '', line: i + 1 })
    added += 1
  }
  // A one-for-one rewrite (same number of lines) is most often a tweak inside
  // each line: mark the span that changed so it can be emphasised.
  if (dels.length === adds.length) {
    dels.forEach((del, index) => {
      const add = adds[index]!
      const span = changedSpans(del.text, add.text)
      if (span) {
        del.changed = span.before
        add.changed = span.after
      }
    })
  }
  hunk.push(...dels, ...adds)
  for (let i = endA; i < Math.min(a.length, endA + 2); i += 1) {
    hunk.push({ kind: 'ctx', text: a[i] ?? '', line: i + 1 })
  }
  return { added, removed, hunk }
}

function changedSpans(
  before: string,
  after: string,
): { before: [number, number]; after: [number, number] } | null {
  if (before === after) return null
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1
  // Lines rewritten almost entirely gain nothing from a highlighted span.
  if (head + tail < Math.min(before.length, after.length) / 3) return null
  return { before: [head, before.length - tail], after: [head, after.length - tail] }
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}
