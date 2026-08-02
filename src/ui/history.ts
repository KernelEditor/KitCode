export interface HistoryMove {
  index: number | null
  value: string
  draft: string
}

/** Move through prompt history while preserving the unfinished input draft. */
export function moveInputHistory(
  history: string[],
  index: number | null,
  value: string,
  draft: string,
  direction: 'previous' | 'next',
): HistoryMove {
  if (history.length === 0) return { index, value, draft }

  if (direction === 'previous') {
    const nextIndex = index === null ? history.length - 1 : Math.max(0, index - 1)
    return {
      index: nextIndex,
      value: history[nextIndex] ?? value,
      draft: index === null ? value : draft,
    }
  }

  if (index === null) return { index, value, draft }
  if (index < history.length - 1) {
    const nextIndex = index + 1
    return { index: nextIndex, value: history[nextIndex] ?? value, draft }
  }
  return { index: null, value: draft, draft }
}

/** Add one prompt, avoiding accidental duplicate entries and unbounded growth. */
export function appendInputHistory(history: string[], value: string, limit = 100): string[] {
  const text = value.trim()
  if (!text || history.at(-1) === text) return history
  return [...history, text].slice(-limit)
}
