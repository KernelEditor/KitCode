import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bashTool } from '../src/tools/bash'
import { editTool } from '../src/tools/edit'
import { grepTool } from '../src/tools/grep'
import { createPermissionEngine } from '../src/tools/permissions'
import { resolveInside } from '../src/tools/safepath'
import type { Tool, ToolContext } from '../src/tools/types'
import { writeTool } from '../src/tools/write'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'freecode-tools-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function context(): ToolContext {
  return { cwd, signal: new AbortController().signal, confirm: async () => true }
}

describe('resolveInside', () => {
  it('accepts paths inside the root', () => {
    const result = resolveInside(cwd, 'src/app.ts')
    expect(result).toMatchObject({ ok: true })
  })

  it('rejects traversal out of the root', () => {
    expect(resolveInside(cwd, '../escape.txt').ok).toBe(false)
    expect(resolveInside(cwd, 'a/b/../../../escape.txt').ok).toBe(false)
  })

  it('rejects absolute paths outside the root', () => {
    expect(resolveInside(cwd, '/etc/passwd').ok).toBe(false)
  })

  it('rejects a symlink pointing outside the root even when its target is missing', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'freecode-outside-'))
    try {
      await symlink(join(outside, 'ghost.txt'), join(cwd, 'escape'))
      expect(resolveInside(cwd, 'escape').ok).toBe(false)

      const result = await writeTool.execute({ path: 'escape', content: 'pwned' }, context())
      expect(result.isError).toBe(true)
      expect(existsSync(join(outside, 'ghost.txt'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('grep', () => {
  it('refuses a glob that walks out of the root', async () => {
    const result = await grepTool.execute({ pattern: 'x', glob: '../*/*.txt' }, context())
    expect(result.isError).toBe(true)
  })

  it('reports matches relative to the root and only flags a real cap', async () => {
    await writeFile(join(cwd, 'a.txt'), 'hit\nmiss\nhit\n')
    const all = await grepTool.execute({ pattern: 'hit', maxMatches: 2 }, context())
    expect(all.content).toBe('a.txt:1: hit\na.txt:3: hit')

    const capped = await grepTool.execute({ pattern: 'hit', maxMatches: 1 }, context())
    expect(capped.content).toContain('stopped at 1 matches')
  })

  it('matches every line even when the pattern has the global flag', async () => {
    await writeFile(join(cwd, 'g.txt'), 'x\nx\nx\n')
    const result = await grepTool.execute({ pattern: 'x', glob: '**/*.txt' }, context())
    // Without resetting lastIndex, a stateful /g test skips lines inconsistently.
    expect(result.content).toBe('g.txt:1: x\ng.txt:2: x\ng.txt:3: x')
  })

  it('skips binary files without crashing', async () => {
    await writeFile(join(cwd, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]))
    await writeFile(join(cwd, 'text.txt'), 'needle\n')
    const result = await grepTool.execute({ pattern: 'needle' }, context())
    expect(result.content).toBe('text.txt:1: needle')
  })
})

describe('bash', () => {
  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await bashTool.execute(
      { command: `touch ${JSON.stringify(join(cwd, 'ran'))}` },
      { ...context(), signal: controller.signal },
    )
    expect(result.isError).toBe(true)
    expect(existsSync(join(cwd, 'ran'))).toBe(false)
  })
})

describe('edit', () => {
  const file = 'target.ts'

  it('reports no match', async () => {
    await writeFile(join(cwd, file), 'const a = 1\n')
    const result = await editTool.execute({ path: file, oldString: 'nope', newString: 'x' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('applies a unique match', async () => {
    await writeFile(join(cwd, file), 'const a = 1\nconst b = 2\n')
    const result = await editTool.execute({ path: file, oldString: 'const b = 2', newString: 'const b = 3' }, context())
    expect(result.isError).toBeUndefined()
    expect(result.display).toMatchObject({ kind: 'diff', path: file })
    expect(await readFile(join(cwd, file), 'utf8')).toBe('const a = 1\nconst b = 3\n')
  })

  it('refuses two matches without replaceAll and accepts them with it', async () => {
    await writeFile(join(cwd, file), 'x = 1\nx = 1\n')
    const ambiguous = await editTool.execute({ path: file, oldString: 'x = 1', newString: 'x = 2' }, context())
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.content).toContain('2 places')
    expect(await readFile(join(cwd, file), 'utf8')).toBe('x = 1\nx = 1\n')

    const all = await editTool.execute(
      { path: file, oldString: 'x = 1', newString: 'x = 2', replaceAll: true },
      context(),
    )
    expect(all.isError).toBeUndefined()
    expect(await readFile(join(cwd, file), 'utf8')).toBe('x = 2\nx = 2\n')
  })

  it('refuses to edit a binary file', async () => {
    const bin = 'blob.data'
    await writeFile(join(cwd, bin), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]))
    const result = await editTool.execute({ path: bin, oldString: 'x', newString: 'y' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('binary')
  })
})

describe('write', () => {
  const file = 'out.txt'

  it('creates a new file', async () => {
    const result = await writeTool.execute({ path: file, content: 'hello\n' }, context())
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('Created')
    expect(await readFile(join(cwd, file), 'utf8')).toBe('hello\n')
  })

  it('refuses to overwrite a binary file', async () => {
    const bin = 'blob.data'
    await writeFile(join(cwd, bin), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const result = await writeTool.execute({ path: bin, content: 'not binary' }, context())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('binary')
  })
})

describe('permission engine', () => {
  const tool = (name: string, defaultPermission: Tool['defaultPermission']): Tool => ({
    name,
    description: '',
    inputSchema: {},
    defaultPermission,
    summarize: () => name,
    execute: async () => ({ content: '' }),
  })

  it('lets config override the tool default', () => {
    const engine = createPermissionEngine({ bash: 'allow' })
    expect(engine.resolve(tool('bash', 'ask'))).toBe('allow')
    expect(engine.decide(tool('write', 'ask'))).toBe('ask')
  })

  it('keeps a configured deny even under bypass or a session grant', () => {
    const engine = createPermissionEngine({ bash: 'deny' })
    const bash = tool('bash', 'ask')

    engine.grantForSession('bash')
    expect(engine.decide(bash)).toBe('deny')

    engine.bypass.enable()
    expect(engine.bypass.isEnabled()).toBe(true)
    expect(engine.decide(bash)).toBe('deny')
    expect(engine.decide(tool('write', 'ask'))).toBe('allow')

    engine.bypass.disable()
    expect(engine.decide(tool('write', 'ask'))).toBe('ask')
  })

  it('promotes ask to allow after a session grant', () => {
    const engine = createPermissionEngine({})
    const write = tool('write', 'ask')
    expect(engine.decide(write)).toBe('ask')
    engine.grantForSession('write')
    expect(engine.decide(write)).toBe('allow')
  })
})

describe('agent modes', () => {
  const tool = (name: string, defaultPermission: Tool['defaultPermission']): Tool => ({
    name,
    description: '',
    inputSchema: {},
    defaultPermission,
    summarize: () => name,
    execute: async () => ({ content: '' }),
  })

  const write = tool('write', 'ask')
  const bash = tool('bash', 'ask')
  const read = tool('read', 'allow')
  const mcp = tool('mcp__github__create_issue', 'ask')

  it('cycles normal -> accept -> plan -> normal', () => {
    const engine = createPermissionEngine({})
    expect(engine.mode.get()).toBe('normal')
    expect(engine.mode.cycle()).toBe('accept')
    expect(engine.mode.cycle()).toBe('plan')
    expect(engine.mode.cycle()).toBe('normal')
  })

  it('auto-accepts file edits but still asks for shell', () => {
    const engine = createPermissionEngine({})
    engine.mode.set('accept')
    expect(engine.decide(write)).toBe('allow')
    expect(engine.decide(bash)).toBe('ask')
    expect(engine.decide(mcp)).toBe('ask')
  })

  it('plan mode blocks every side effect but keeps reading', () => {
    const engine = createPermissionEngine({})
    engine.mode.set('plan')
    expect(engine.decide(write)).toBe('deny')
    expect(engine.decide(bash)).toBe('deny')
    expect(engine.decide(mcp)).toBe('deny')
    expect(engine.decide(read)).toBe('allow')
  })

  it('explains a plan-mode denial so the model plans instead of retrying', () => {
    const engine = createPermissionEngine({})
    engine.mode.set('plan')
    expect(engine.denyReason(write)).toMatch(/plan mode/i)
    expect(engine.denyReason(read)).toBeUndefined()
  })

  it('plan mode outranks bypass', () => {
    const engine = createPermissionEngine({})
    engine.bypass.enable()
    engine.mode.set('plan')
    expect(engine.decide(bash)).toBe('deny')
  })

  it('a configured deny still wins in every mode', () => {
    const engine = createPermissionEngine({ bash: 'deny' })
    for (const mode of ['normal', 'accept', 'plan'] as const) {
      engine.mode.set(mode)
      engine.bypass.enable()
      expect(engine.decide(bash)).toBe('deny')
    }
  })
})
