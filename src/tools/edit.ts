import { readFile, writeFile } from 'node:fs/promises'
import { resolveInside } from './safepath'
import { brief } from './summary'
import type { Tool } from './types'

interface EditInput {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

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
      oldString: { type: 'string', description: 'Text to replace, with enough context to be unique' },
      newString: { type: 'string', description: 'Replacement text' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  defaultPermission: 'ask',
  summarize(input) {
    return `edit(${brief((input as EditInput).path)})`
  },
  async execute(input, ctx) {
    const { path, oldString, newString, replaceAll = false } = input as EditInput
    const safe = resolveInside(ctx.cwd, path)
    if (!safe.ok) return { content: safe.reason, isError: true }

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

    let after: string
    if (replaceAll) {
      after = before.split(oldString).join(newString)
    } else {
      const at = before.indexOf(oldString)
      after = before.slice(0, at) + newString + before.slice(at + oldString.length)
    }

    try {
      await writeFile(safe.path, after, 'utf8')
    } catch (error) {
      return { content: `Failed to write ${path}: ${(error as Error).message}`, isError: true }
    }

    return {
      content: `Edited ${path} (${count} ${count === 1 ? 'replacement' : 'replacements'})`,
      display: { kind: 'diff', path, before, after },
    }
  },
}
