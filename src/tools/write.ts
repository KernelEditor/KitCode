import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

interface WriteInput {
  path: string
  content: string
}

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write a file, replacing it if it already exists. Missing parent directories are created. Prefer edit for changing part of an existing file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root' },
      content: { type: 'string', description: 'Full file contents' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  defaultPermission: 'ask',
  summarize(input) {
    return `write(${brief((input as WriteInput).path)})`
  },
  async execute(input, ctx) {
    const { path, content } = input as WriteInput
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const beforeBuffer = await readFile(safe.path).catch(() => null)
    if (beforeBuffer instanceof Buffer && beforeBuffer.subarray(0, 8192).includes(0)) {
      return { content: `Cannot write ${path}: the existing file is binary, not text.`, isError: true }
    }
    let before = ''
    if (beforeBuffer) before = beforeBuffer.toString('utf8')
    try {
      await mkdir(dirname(safe.path), { recursive: true })
      await writeFile(safe.path, content, 'utf8')
    } catch (error) {
      return { content: `Failed to write ${path}: ${(error as Error).message}`, isError: true }
    }

    const lines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length
    return {
      content: `${before === '' ? 'Created' : 'Updated'} ${path} (${lines} ${lines === 1 ? 'line' : 'lines'})`,
      display: { kind: 'diff', path, before, after: content },
    }
  },
}
