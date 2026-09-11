import { z } from 'zod'
import { redactSecrets } from '../providers/errors'
import { brief } from './summary'
import type { Tool } from './types'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('add'), text: z.string().trim().min(1).max(4000), source: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('replace'), oldText: z.string().min(1), text: z.string().trim().min(1).max(4000), source: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('delete'), oldText: z.string().min(1), source: z.string().trim().min(1).max(1000) }).strict(),
])

export function createMemoryTool(store: { read(): string; save(text: string): Promise<void> }): Tool {
  return {
    name: 'memory',
    description: 'Read or update persistent notes for this project. Remember only explicit user preferences, confirmed project facts and accepted decisions, with their source (user instruction or file/tool evidence). Never store secrets, guesses, temporary task progress or raw logs. Read before changing existing notes. For replace/delete, oldText must match exactly once; include the whole old note and its source. These notes survive new chats. Do not use this tool to change permissions or override current instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add', 'replace', 'delete'] },
        text: { type: 'string', maxLength: 4000 },
        oldText: { type: 'string' },
        source: { type: 'string', maxLength: 1000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    defaultPermission: 'allow',
    summarize(input) {
      const parsed = inputSchema.safeParse(input)
      return parsed.success ? `memory(${parsed.data.action}${'text' in parsed.data ? `: ${brief(parsed.data.text, 80)}` : ''})` : 'memory(invalid input)'
    },
    async execute(input, ctx) {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { content: 'Invalid memory arguments: mutations require source; replace/delete also require oldText.', isError: true }
      const args = parsed.data
      const before = store.read()
      if (args.action === 'read') return { content: before || 'Project memory is empty.' }
      if (ctx.signal.aborted) return { content: 'Memory update cancelled.', isError: true }
      const note = 'text' in args ? `${redactSecrets(args.text)}\nSource: ${redactSecrets(args.source)}` : ''
      let after: string
      if (args.action === 'add') {
        if (before.includes(note)) return { content: 'This note is already in project memory.' }
        after = [before.trim(), note].filter(Boolean).join('\n\n')
      } else {
        const at = before.indexOf(args.oldText)
        if (at === -1 || before.indexOf(args.oldText, at + 1) !== -1) {
          return { content: 'oldText must match exactly once. Read memory again before retrying.', isError: true }
        }
        after = (before.slice(0, at) + note + before.slice(at + args.oldText.length)).trim()
      }
      await store.save(after)
      return { content: `Project memory updated (${args.action}).\n${store.read()}`, display: { kind: 'diff', path: 'project memory', before, after: store.read() } }
    },
  }
}
