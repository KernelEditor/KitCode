import { createContext, useContext } from 'react'

export const PRESETS: Record<string, string> = {
  purple: '#a78bfa',
  violet: '#8b5cf6',
  blue: '#60a5fa',
  cyan: '#22d3ee',
  green: '#4ade80',
  orange: '#fb923c',
  pink: '#f472b6',
  red: '#f87171',
  yellow: '#fbbf24',
  white: '#e5e7eb',
}

export const DEFAULT_ACCENT = PRESETS.purple as string

export interface Theme {
  accent: string
  ok: string
  warn: string
  error: string
}

/**
 * Normalises what the user typed into a stored accent: a preset name, or a
 * hex colour as #rrggbb (also accepting #rgb and a missing "#"). Undefined
 * when it is neither, so a typo is reported instead of silently ignored.
 */
export function parseAccent(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase()
  if (Object.hasOwn(PRESETS, trimmed)) return trimmed
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed)?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  return `#${full}`
}

export function resolveAccent(value: string | undefined): string {
  if (!value) return DEFAULT_ACCENT
  const parsed = parseAccent(value)
  if (!parsed) return DEFAULT_ACCENT
  return PRESETS[parsed] ?? parsed
}

export function makeTheme(accent: string | undefined): Theme {
  return {
    accent: resolveAccent(accent),
    ok: PRESETS.green as string,
    warn: PRESETS.yellow as string,
    error: PRESETS.red as string,
  }
}

export const ThemeContext = createContext<Theme>(makeTheme(undefined))

export function useTheme(): Theme {
  return useContext(ThemeContext)
}
