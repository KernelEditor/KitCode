// When the user types with a Russian keyboard layout, the same physical key
// produces a different character. Ink's `useInput` hands us whatever the OS
// produced, so a check like `char === 'y'` fails when the layout is Russian
// (the Y key emits `н`). Map the Russian characters back to their English
// counterparts so single-key hotkeys work regardless of layout.

// Russian -> English, covering only the keys used as hotkeys (y/a/n).
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
