import { readFile, stat } from 'node:fs/promises'
import { resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'
import { isSensitivePath } from './sensitive'

const MAX_LINES = 2000
const MAX_CHARS = 200_000
const MAX_FILE_BYTES = 5_000_000

interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a text file from the workspace. Returns numbered lines. Use offset and limit to page through large files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root' },
      offset: { type: 'integer', description: '1-based line to start from', minimum: 1 },
      limit: { type: 'integer', description: 'Maximum number of lines to return', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  defaultPermission: 'allow',
  permission(input, ctx) {
    const target = (input as Partial<ReadInput> | null)?.path
    if (isSensitivePath(target)) return 'ask'
    const safe = ctx && target ? resolveInside(ctx.cwd, target) : undefined
    return safe?.ok && isSensitivePath(safe.relative) ? 'ask' : undefined
  },
  summarize(input) {
    return `read(${brief((input as ReadInput).path)})`
  },
  async execute(input, ctx) {
    const { path, offset = 1, limit } = input as ReadInput
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const info = await stat(safe.path).catch(() => null)
    if (!info) return { content: `File not found: ${path}`, isError: true }
    if (info.isDirectory()) {
      return { content: `${path} is a directory, not a file. Use glob to list its contents.`, isError: true }
    }
    if (info.size > MAX_FILE_BYTES) {
      return {
        content: `${path} is ${(info.size / 1_000_000).toFixed(1)} MB; read is limited to ${MAX_FILE_BYTES / 1_000_000} MB per file. Use grep or another targeted tool instead.`,
        isError: true,
      }
    }

    const buffer = await readFile(safe.path)
    if (buffer.subarray(0, 4096).includes(0)) {
      return { content: `${path} looks like a binary file and cannot be read as text.`, isError: true }
    }

    const lines = buffer.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.length === 0) return { content: `${path} is empty.` }

    const start = Math.max(1, offset) - 1
    if (start >= lines.length) {
      return { content: `${path} has ${lines.length} lines, so offset ${offset} is past the end.`, isError: true }
    }

    const window = lines.slice(start, start + Math.min(limit ?? MAX_LINES, MAX_LINES))
    const rendered: string[] = []
    let chars = 0
    for (const [index, line] of window.entries()) {
      const numbered = `${start + index + 1}\t${line}`
      if (chars + numbered.length > MAX_CHARS) break
      chars += numbered.length + 1
      rendered.push(numbered)
    }

    const remaining = lines.length - (start + rendered.length)
    if (remaining > 0) {
      rendered.push(
        `... truncated: ${remaining} more lines. Continue with offset ${start + rendered.length + 1}.`,
      )
    }
    return { content: rendered.join('\n') }
  },
}
