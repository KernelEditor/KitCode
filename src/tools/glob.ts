import { join } from 'node:path'
import fg from 'fast-glob'
import { patternEscapes, resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

const MAX_RESULTS = 500

export const IGNORED_DIRECTORIES = ['**/node_modules/**', '**/.git/**', '**/dist/**']

interface GlobInput {
  pattern: string
  path?: string
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by glob pattern, most recently modified first. Supports patterns like "src/**/*.ts". Hidden files, node_modules, .git and dist are skipped.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.test.ts' },
      path: { type: 'string', description: 'Directory to search in, relative to the workspace root' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  defaultPermission: 'allow',
  summarize(input) {
    return `glob(${brief((input as GlobInput).pattern)})`
  },
  async execute(input, ctx) {
    const { pattern, path = '.' } = input as GlobInput
    if (patternEscapes(pattern)) {
      return { content: `Pattern ${pattern} must be relative to the workspace root.`, isError: true }
    }
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const entries = await fg(pattern, {
      cwd: safe.path,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: IGNORED_DIRECTORIES,
      stats: true,
    })
    if (entries.length === 0) return { content: `No files matched ${pattern}` }

    entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
    const paths = entries.slice(0, MAX_RESULTS).map((entry) => join(safe.relative, entry.path))
    if (entries.length > MAX_RESULTS) {
      paths.push(`... truncated: ${entries.length - MAX_RESULTS} more files matched.`)
    }
    return { content: paths.join('\n') }
  },
}
