import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import fg from 'fast-glob'
import { IGNORED_DIRECTORIES } from './glob'
import { patternEscapes, resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 1_000_000
const MAX_LINE_WIDTH = 300

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  maxMatches?: number
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns matching lines as path:line: text, most recently modified files first.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path: { type: 'string', description: 'Directory to search in, relative to the workspace root' },
      glob: { type: 'string', description: 'Glob limiting which files are searched, e.g. **/*.ts' },
      maxMatches: { type: 'integer', description: `Maximum matches to return (default ${MAX_MATCHES})`, minimum: 1 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  defaultPermission: 'allow',
  summarize(input) {
    return `grep(${brief((input as GrepInput).pattern)})`
  },
  async execute(input, ctx) {
    const { pattern, path = '.', glob = '**/*', maxMatches } = input as GrepInput
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (error) {
      return { content: `Invalid regular expression: ${(error as Error).message}`, isError: true }
    }

    if (patternEscapes(glob)) {
      return { content: `Glob ${glob} must be relative to the workspace root.`, isError: true }
    }

    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const target = await stat(safe.path).catch(() => null)
    if (!target) return { content: `Path not found: ${path}`, isError: true }

    const files = target.isDirectory()
      ? (
          await fg(glob, {
            cwd: safe.path,
            dot: false,
            onlyFiles: true,
            followSymbolicLinks: false,
            suppressErrors: true,
            ignore: IGNORED_DIRECTORIES,
            stats: true,
          })
        )
          .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
          .map((entry) => ({
            absolute: join(safe.path, entry.path),
            relative: join(safe.relative, entry.path),
            size: entry.stats?.size ?? 0,
          }))
      : [{ absolute: safe.path, relative: safe.relative, size: target.size }]

    const limit = Math.min(maxMatches ?? MAX_MATCHES, MAX_MATCHES)
    const hits: string[] = []
    let capped = false

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) continue
      const buffer = await readFile(file.absolute).catch(() => null)
      if (!buffer || buffer.subarray(0, 4096).includes(0)) continue

      const lines = buffer.toString('utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        const matched = regex.test(line)
        // With the global flag, lastIndex is left advanced after test() and
        // the next line is matched inconsistently. Reset it for every line.
        regex.lastIndex = 0
        if (!matched) continue
        if (hits.length === limit) {
          capped = true
          break
        }
        const text = line.trim()
        hits.push(
          `${file.relative}:${index + 1}: ${text.length > MAX_LINE_WIDTH ? `${text.slice(0, MAX_LINE_WIDTH)}…` : text}`,
        )
      }
      if (capped) break
    }

    if (hits.length === 0) return { content: `No matches for ${pattern}` }
    if (capped) hits.push(`... stopped at ${limit} matches. Narrow the pattern or glob for the rest.`)
    return { content: hits.join('\n') }
  },
}
