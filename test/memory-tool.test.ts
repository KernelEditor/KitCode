import { describe, expect, it } from 'vitest'
import { createMemoryTool } from '../src/tools/memory'
import { createPermissionEngine } from '../src/tools/permissions'
import type { ToolContext } from '../src/tools/types'

const context = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal, confirm: async () => true })
function setup() {
  let text = ''
  const tool = createMemoryTool({ read: () => text, save: async (next) => { text = next } })
  return { tool, read: () => text }
}

describe('agent project memory tool', () => {
  it('adds a sourced note, avoids duplicates, replaces and deletes it', async () => {
    const { tool, read } = setup()
    const note = { action: 'add', text: 'Changelog only in GitHub releases.', source: 'User instruction' }
    await tool.execute(note, context())
    expect(read()).toBe('Changelog only in GitHub releases.\nSource: User instruction')
    await tool.execute(note, context())
    expect(read().match(/Changelog/g)).toHaveLength(1)
    const result = await tool.execute({ action: 'replace', oldText: read(), text: 'Run tests before release.', source: 'Updated user instruction' }, context())
    expect(result.display?.kind).toBe('diff')
    expect(read()).not.toContain('Changelog')
    expect((await tool.execute({ action: 'read' }, context())).content).toBe(read())
    await tool.execute({ action: 'delete', oldText: read(), source: 'User asked to forget' }, context())
    expect(read()).toBe('')
  })
  it('rejects missing evidence, stale edits and cancelled writes', async () => {
    const { tool, read } = setup()
    expect((await tool.execute({ action: 'add', text: 'guess' }, context())).isError).toBe(true)
    expect((await tool.execute({ action: 'delete', oldText: 'missing', source: 'user' }, context())).isError).toBe(true)
    const controller = new AbortController()
    controller.abort()
    expect((await tool.execute({ action: 'add', text: 'note', source: 'user' }, { ...context(), signal: controller.signal })).isError).toBe(true)
    expect(read()).toBe('')
  })
  it('obeys explicit denial and plan-mode restrictions', () => {
    const { tool } = setup()
    const permissions = createPermissionEngine({})
    expect(permissions.decide(tool)).toBe('allow')
    permissions.mode.set('plan')
    expect(permissions.decide(tool)).toBe('deny')
    expect(createPermissionEngine({ memory: 'deny' }).decide(tool)).toBe('deny')
  })
})
