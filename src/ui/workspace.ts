import { homedir } from 'node:os'
import { sanitizeTerminalText } from './sanitize'

export function formatWorkspacePath(
  value: string,
  maxWidth: number,
  home = homedir(),
): string {
  const width = Math.max(1, Math.floor(maxWidth))
  const safe = oneLine(value)
  if (!safe) return ''

  const safeHome = oneLine(home).replace(/[\\/]+$/, '')
  const display = isInsideHome(safe, safeHome) ? `~${safe.slice(safeHome.length)}` : safe
  if (characters(display).length <= width) return display
  if (width === 1) return '…'

  const separator = display.includes('\\') && !display.includes('/') ? '\\' : '/'
  const parts = display.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return tail(display, width)

  const prefix = `…${separator}`
  const available = width - characters(prefix).length
  if (available <= 0) return tail(prefix, width)

  let result = parts.at(-1) ?? ''
  if (characters(result).length > available) return `${prefix}${tail(result, available)}`

  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const candidate = `${parts[index]}${separator}${result}`
    if (characters(prefix + candidate).length > width) break
    result = candidate
  }
  return `${prefix}${result}`
}

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/[\t\r\n]+/g, ' ').trim()
}

function isInsideHome(value: string, home: string): boolean {
  if (!home) return false
  return value === home || value.startsWith(`${home}/`) || value.startsWith(`${home}\\`)
}

function characters(value: string): string[] {
  return [...value]
}

function tail(value: string, width: number): string {
  return characters(value).slice(-width).join('')
}
