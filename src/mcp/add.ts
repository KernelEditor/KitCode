import type { McpServerConfig } from '../config/schema'
import { mcpServerSchema } from '../config/schema'

export type McpAddError =
  | 'usage'
  | 'invalid-name'
  | 'invalid-url'
  | 'http-args'
  | 'invalid-env'
  | 'invalid-header'
  | 'option-mismatch'

export type McpAddParseResult =
  | { ok: true; name: string; config: McpServerConfig }
  | { ok: false; error: McpAddError }

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `/mcp add` from the raw text after the command, with quoting. */
export function parseMcpAddCommand(raw: string): McpAddParseResult {
  const args = splitCommandLine(raw)
  return args ? parseMcpAddArgs(args) : { ok: false, error: 'usage' }
}

/**
 * <name> [-e KEY=VALUE]... [-H "Name: value"]... <https://url>
 * <name> [-e KEY=VALUE]... [--] <command> [args...]
 * Options go before the URL or command; everything after the command is
 * passed to it untouched. The words "http" and "stdio" may still name the type.
 */
export function parseMcpAddArgs(args: string[]): McpAddParseResult {
  const [name, ...tail] = args
  if (!name) return { ok: false, error: 'usage' }
  if (!SERVER_NAME.test(name)) return { ok: false, error: 'invalid-name' }

  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  let index = 0
  for (; index < tail.length; index += 1) {
    const option = tail[index] as string
    if (option === '-e' || option === '--env') {
      const value = tail[++index]
      const eq = value?.indexOf('=') ?? -1
      if (!value || eq <= 0 || !ENV_NAME.test(value.slice(0, eq))) return { ok: false, error: 'invalid-env' }
      env[value.slice(0, eq)] = value.slice(eq + 1)
      continue
    }
    if (option === '-H' || option === '--header') {
      const value = tail[++index]
      const colon = value?.indexOf(':') ?? -1
      const key = value && colon > 0 ? value.slice(0, colon).trim() : ''
      if (!value || !HEADER_NAME.test(key)) return { ok: false, error: 'invalid-header' }
      headers[key] = value.slice(colon + 1).trim()
      continue
    }
    break
  }

  let rest = tail.slice(index)
  let kind: 'http' | 'stdio' | undefined
  if (rest[0] === 'http') {
    kind = 'http'
    rest = rest.slice(1)
  } else if (rest[0] === 'stdio' || rest[0] === '--') {
    kind = 'stdio'
    rest = rest.slice(1)
  }
  const [target, ...extra] = rest
  if (!target) return { ok: false, error: 'usage' }
  kind ??= /^https?:\/\//i.test(target) ? 'http' : 'stdio'

  if (kind === 'http') {
    if (extra.length > 0) return { ok: false, error: 'http-args' }
    if (Object.keys(env).length > 0) return { ok: false, error: 'option-mismatch' }
    const parsed = mcpServerSchema.safeParse({ type: 'http', url: target, headers })
    return parsed.success ? { ok: true, name, config: parsed.data } : { ok: false, error: 'invalid-url' }
  }

  if (Object.keys(headers).length > 0) return { ok: false, error: 'option-mismatch' }
  const parsed = mcpServerSchema.safeParse({ type: 'stdio', command: target, args: extra, env })
  return parsed.success ? { ok: true, name, config: parsed.data } : { ok: false, error: 'usage' }
}

/**
 * Split like a shell would for the simple cases people type: whitespace
 * separates words, "double" or 'single' quotes keep spaces. Backslashes are
 * literal so Windows paths survive. Null for an unclosed quote.
 */
export function splitCommandLine(raw: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      inWord = true
      continue
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      continue
    }
    current += char
    inWord = true
  }
  if (quote) return null
  if (inWord) words.push(current)
  return words
}
