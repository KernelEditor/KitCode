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

export function resolveAccent(value: string | undefined): string {
  if (!value) return DEFAULT_ACCENT
  const preset = PRESETS[value.toLowerCase()]
  if (preset) return preset
  return /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_ACCENT
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
