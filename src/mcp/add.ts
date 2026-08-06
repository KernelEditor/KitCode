import type { McpServerConfig } from '../config/schema'
import { mcpServerSchema } from '../config/schema'

export type McpAddError = 'usage' | 'invalid-name' | 'invalid-url' | 'http-args'

export type McpAddParseResult =
  | { ok: true; name: string; config: McpServerConfig }
  | { ok: false; error: McpAddError }

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function parseMcpAddArgs(args: string[]): McpAddParseResult {
  const [name, first, ...remaining] = args
  if (!name || !first) return { ok: false, error: 'usage' }
  if (!SERVER_NAME.test(name)) return { ok: false, error: 'invalid-name' }

  if (first === 'http') {
    const [url, ...extra] = remaining
    if (!url) return { ok: false, error: 'usage' }
    if (extra.length > 0) return { ok: false, error: 'http-args' }
    return httpServer(name, url)
  }

  if (first === 'stdio' || first === '--') {
    const [command, ...commandArgs] = remaining
    if (!command) return { ok: false, error: 'usage' }
    return stdioServer(name, command, commandArgs)
  }

  if (/^https?:\/\//.test(first)) {
    if (remaining.length > 0) return { ok: false, error: 'http-args' }
    return httpServer(name, first)
  }

  return stdioServer(name, first, remaining)
}

function httpServer(name: string, url: string): McpAddParseResult {
  const parsed = mcpServerSchema.safeParse({ type: 'http', url })
  return parsed.success
    ? { ok: true, name, config: parsed.data }
    : { ok: false, error: 'invalid-url' }
}

function stdioServer(name: string, command: string, args: string[]): McpAddParseResult {
  const parsed = mcpServerSchema.safeParse({ type: 'stdio', command, args })
  return parsed.success
    ? { ok: true, name, config: parsed.data }
    : { ok: false, error: 'usage' }
}
