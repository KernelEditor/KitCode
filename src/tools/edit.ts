import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

interface EditInput {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

const MAX_FILE_BYTES = 5_000_000

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace an exact string in a file. oldString must match the file byte for byte, including indentation, and must be unique unless replaceAll is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root' },
      oldString: {
        type: 'string',
        description: 'Text to replace, with enough context to be unique',
        maxLength: MAX_FILE_BYTES,
      },
      newString: { type: 'string', description: 'Replacement text', maxLength: MAX_FILE_BYTES },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  defaultPermission: 'ask',
  summarize(input) {
    return `edit(${brief((input as EditInput).path)})`
  },
  async preview(input, ctx) {
    const { path, oldString, newString, replaceAll = false } = input as EditInput
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { kind: 'text', text: safe.reason }
    const info = await stat(safe.path).catch(() => null)
    if (info && info.size > MAX_FILE_BYTES) {
      return { kind: 'text', text: `Cannot preview ${path}: the file is too large.` }
    }
    const beforeBuffer = await readFile(safe.path).catch(() => null)
    if (!beforeBuffer) return { kind: 'text', text: `Cannot read ${path}.` }
    if (beforeBuffer.subarray(0, 8192).includes(0)) {
      return { kind: 'text', text: `Cannot preview binary file ${path}` }
    }
    const before = beforeBuffer.toString('utf8')
    const after = replacement(before, oldString, newString, replaceAll)
    return after === null
      ? { kind: 'text', text: `Cannot preview edit: oldString is not a valid match in ${path}.` }
      : { kind: 'diff', path, before, after }
  },
  async execute(input, ctx) {
    const { path, oldString, newString, replaceAll = false } = input as EditInput
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

    const info = await stat(safe.path).catch(() => null)
    if (info && info.size > MAX_FILE_BYTES) {
      return {
        content: `Cannot edit ${path}: the file exceeds the ${MAX_FILE_BYTES / 1_000_000} MB limit.`,
        isError: true,
      }
    }
    const beforeBuffer = await readFile(safe.path).catch(() => null)
    if (beforeBuffer === null) return { content: `Cannot read ${path}.`, isError: true }
    if (beforeBuffer.subarray(0, 8192).includes(0)) {
      return { content: `Cannot edit ${path}: it is a binary file, not text.`, isError: true }
    }
    const before = beforeBuffer.toString('utf8')

    const count = countOccurrences(before, oldString)
    if (count === 0) {
      return {
        content: `oldString was not found in ${path}. Read the file again and match the text exactly, including whitespace.`,
        isError: true,
      }
    }
    if (count > 1 && !replaceAll) {
      return {
        content: `oldString matches ${count} places in ${path}. Add more surrounding context to identify a single one, or set replaceAll to true.`,
        isError: true,
      }
    }

    const after = replacement(before, oldString, newString, replaceAll)
    if (after === null) return { content: `Could not prepare edit for ${path}.`, isError: true }
    if (Buffer.byteLength(after, 'utf8') > MAX_FILE_BYTES) {
      return {
        content: `Cannot edit ${path}: the result exceeds the ${MAX_FILE_BYTES / 1_000_000} MB limit.`,
        isError: true,
      }
    }

    try {
      await ctx.checkpoint?.capture(safe.path)
    } catch (error) {
      return { content: `Checkpoint capture failed: ${(error as Error).message}`, isError: true }
    }
    try {
      await writeFile(safe.path, after, 'utf8')
      ctx.checkpoint?.markChanged(safe.path)
    } catch (error) {
      return { content: `Failed to write ${path}: ${(error as Error).message}`, isError: true }
    }

    return {
      content: `Edited ${path} (${count} ${count === 1 ? 'replacement' : 'replacements'})`,
      display: { kind: 'diff', path, before, after },
    }
  },
}

function replacement(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null {
  const count = countOccurrences(before, oldString)
  if (count === 0 || (count > 1 && !replaceAll)) return null
  if (replaceAll) return before.split(oldString).join(newString)
  const at = before.indexOf(oldString)
  return before.slice(0, at) + newString + before.slice(at + oldString.length)
}
