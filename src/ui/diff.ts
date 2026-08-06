export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
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
    hunk.push({ kind: 'ctx', text: a[i] ?? '' })
  }
  for (let i = start; i < endA; i += 1) {
    hunk.push({ kind: 'del', text: a[i] ?? '' })
    removed += 1
  }
  for (let i = start; i < endB; i += 1) {
    hunk.push({ kind: 'add', text: b[i] ?? '' })
    added += 1
  }
  for (let i = endA; i < Math.min(a.length, endA + 2); i += 1) {
    hunk.push({ kind: 'ctx', text: a[i] ?? '' })
  }
  return { added, removed, hunk }
}

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}
