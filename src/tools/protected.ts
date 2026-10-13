import path from 'node:path'
import { resolveInside } from './safepath'
import type { PermissionMode, ToolContext } from './types'

/**
 * Files whose contents decide what runs later, outside any approval: the
 * project config (permissions, MCP commands), project skills, git hooks and
 * config, direnv. A write to one of them is always confirmed, even in accept
 * mode, so an edit cannot quietly turn into command execution.
 */
export function protectedWritePermission(input: unknown, ctx?: ToolContext): PermissionMode | undefined {
  const target = (input as { path?: unknown } | null)?.path
  if (typeof target !== 'string') return undefined
  const relative = ctx ? resolveInside(ctx.cwd, target) : undefined
  const candidate = relative?.ok ? relative.relative : target
  return isProtectedPath(candidate) ? 'ask' : undefined
}

export function isProtectedPath(value: string): boolean {
  const parts = path.normalize(value).replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean)
  const name = parts.at(-1) ?? ''
  return (
    name === 'kitcode.json' ||
    name === '.envrc' ||
    parts.includes('.kitcode') ||
    parts.includes('.git')
  )
}
