

const RU_TO_EN: Record<string, string> = {
  н: 'y',
  ф: 'a',
  т: 'n',
}

export function normalizeHotkey(char: string | undefined): string {
  if (!char) return ''
  const lower = char.toLowerCase()
  return RU_TO_EN[lower] ?? lower
}
