import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

interface WriteInput {
  path: string
  content: string
}

const MAX_FILE_BYTES = 5_000_000

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write a file, replacing it if it already exists. Missing parent directories are created. Prefer edit for changing part of an existing file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root' },
      content: { type: 'string', description: 'Full file contents', maxLength: MAX_FILE_BYTES },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  defaultPermission: 'ask',
  summarize(input) {
    return `write(${brief((input as WriteInput).path)})`
  },
  async preview(input, ctx) {
    const { path, content } = input as WriteInput
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return { kind: 'text', text: `Write is limited to ${MAX_FILE_BYTES / 1_000_000} MB.` }
    }
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { kind: 'text', text: safe.reason }
    const beforeInfo = await stat(safe.path).catch(() => null)
    if (beforeInfo && beforeInfo.size > MAX_FILE_BYTES) {
      return { kind: 'text', text: `Cannot preview ${path}: the existing file is too large.` }
    }
    const beforeBuffer = await readFile(safe.path).catch(() => null)
    if (beforeBuffer?.subarray(0, 8192).includes(0)) {
      return { kind: 'text', text: `Cannot preview binary file ${path}` }
    }
    return {
      kind: 'diff',
      path,
      before: beforeBuffer?.toString('utf8') ?? '',
      after: content,
    }
  },
  async execute(input, ctx) {
    const { path, content } = input as WriteInput
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return {
        content: `Cannot write ${path}: content exceeds the ${MAX_FILE_BYTES / 1_000_000} MB limit.`,
        isError: true,
      }
    }
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const beforeInfo = await stat(safe.path).catch(() => null)
    if (beforeInfo && beforeInfo.size > MAX_FILE_BYTES) {
      return {
        content: `Cannot replace ${path}: the existing file exceeds the ${MAX_FILE_BYTES / 1_000_000} MB limit.`,
        isError: true,
      }
    }
    const beforeBuffer = await readFile(safe.path).catch(() => null)
    if (beforeBuffer instanceof Buffer && beforeBuffer.subarray(0, 8192).includes(0)) {
      return { content: `Cannot write ${path}: the existing file is binary, not text.`, isError: true }
    }
    let before = ''
    if (beforeBuffer) before = beforeBuffer.toString('utf8')
    try {
      await mkdir(dirname(safe.path), { recursive: true })
      const rechecked = resolveInside(ctx.cwd, path)
      if (!rechecked.ok || rechecked.path !== safe.path) {
        return { content: `Cannot write ${path}: its resolved location changed.`, isError: true }
      }
      await ctx.checkpoint?.capture(rechecked.path)
      const finalPath = resolveInside(ctx.cwd, path)
      if (!finalPath.ok || finalPath.path !== rechecked.path) {
        return { content: `Cannot write ${path}: its resolved location changed.`, isError: true }
      }
      await writeFile(finalPath.path, content, 'utf8')
      ctx.checkpoint?.markChanged(finalPath.path)
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
