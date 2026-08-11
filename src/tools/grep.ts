import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import fg from 'fast-glob'
import { IGNORED_DIRECTORIES } from './glob'
import { patternEscapes, resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'
import { isSensitivePath, mentionsSensitivePattern } from './sensitive'
import { createRegexMatcher } from './regex'

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 1_000_000
const MAX_LINE_WIDTH = 300
const MAX_PATTERN_CHARS = 2_000
const MAX_FILES = 5_000
const MAX_TOTAL_BYTES = 50_000_000

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
      pattern: {
        type: 'string',
        description: 'JavaScript regular expression',
        maxLength: MAX_PATTERN_CHARS,
      },
      path: { type: 'string', description: 'Directory to search in, relative to the workspace root' },
      glob: { type: 'string', description: 'Glob limiting which files are searched, e.g. **/*.ts' },
      maxMatches: { type: 'integer', description: `Maximum matches to return (default ${MAX_MATCHES})`, minimum: 1 },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  defaultPermission: 'allow',
  readOnly: true,
  permission(input, ctx) {
    const { path, glob } = (input as Partial<GrepInput> | null) ?? {}
    if (isSensitivePath(path) || mentionsSensitivePattern(glob)) return 'ask'
    const safe = ctx && path ? resolveInside(ctx.cwd, path) : undefined
    return safe?.ok && isSensitivePath(safe.relative) ? 'ask' : undefined
  },
  summarize(input) {
    return `grep(${brief((input as GrepInput).pattern)})`
  },
  async execute(input, ctx) {
    const { pattern, path = '.', glob = '**/*', maxMatches } = input as GrepInput
    if (pattern.length > MAX_PATTERN_CHARS) {
      return {
        content: `Regular expression is limited to ${MAX_PATTERN_CHARS} characters.`,
        isError: true,
      }
    }
    try {
      new RegExp(pattern)
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

    const discovered = target.isDirectory()
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
    const files = discovered.slice(0, MAX_FILES)
    const filesCapped = discovered.length > MAX_FILES

    const limit = Math.min(maxMatches ?? MAX_MATCHES, MAX_MATCHES)
    const hits: string[] = []
    let matchCapped = false
    let scanCapped = false
    let scannedBytes = 0
    const matcher = createRegexMatcher(pattern)

    try {
      for (const file of files) {
        if (ctx.signal.aborted) throw new Error('Search interrupted by the user.')
        if (file.size > MAX_FILE_BYTES) continue
        if (scannedBytes + file.size > MAX_TOTAL_BYTES) {
          scanCapped = true
          break
        }
        scannedBytes += file.size
        const buffer = await readFile(file.absolute).catch(() => null)
        if (!buffer || buffer.subarray(0, 4096).includes(0)) continue

        const lines = buffer.toString('utf8').split('\n')
        const remaining = limit - hits.length
        const indexes = await matcher.match(lines, remaining + 1, ctx.signal)
        if (indexes.length > remaining) matchCapped = true
        for (const index of indexes.slice(0, remaining)) {
          const text = (lines[index] ?? '').trim()
          hits.push(
            `${file.relative}:${index + 1}: ${text.length > MAX_LINE_WIDTH ? `${text.slice(0, MAX_LINE_WIDTH)}…` : text}`,
          )
        }
        if (matchCapped) break
      }
    } catch (error) {
      return { content: (error as Error).message, isError: true }
    } finally {
      await matcher.close()
    }

    if (hits.length === 0) return { content: `No matches for ${pattern}` }
    if (matchCapped || scanCapped || filesCapped) {
      hits.push(
        matchCapped
          ? `... stopped at ${limit} matches. Narrow the pattern or glob for the rest.`
          : scanCapped
            ? `... stopped after scanning ${MAX_TOTAL_BYTES / 1_000_000} MB. Narrow the path or glob for the rest.`
          : `... searched the first ${MAX_FILES} files. Narrow the path or glob for the rest.`,
      )
    }
    return { content: hits.join('\n') }
  },
}
