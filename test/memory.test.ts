import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const home = await mkdtemp(path.join(tmpdir(), 'kitcode-memory-'))
process.env.KITCODE_HOME = home
const { readProjectMemory, saveProjectMemory, clearProjectMemory } = await import('../src/core/memory')
const { buildSystemPrompt } = await import('../src/core/prompt')
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  delete process.env.KITCODE_HOME
})

describe('project memory', () => {
  it('isolates projects, replaces notes and clears only the selected project', async () => {
    const a = path.join(home, 'a')
    const b = path.join(home, 'b')
    expect(await readProjectMemory(a)).toBe('')
    await saveProjectMemory(a, 'Run npm test')
    await saveProjectMemory(b, 'Use pytest')
    expect(await readProjectMemory(a)).toBe('Run npm test')
    await saveProjectMemory(a, 'Run npm run typecheck')
    expect(await readProjectMemory(a)).toBe('Run npm run typecheck')
    await clearProjectMemory(a)
    expect(await readProjectMemory(a)).toBe('')
    expect(await readProjectMemory(b)).toBe('Use pytest')
  })
  it('rejects oversized notes without replacing existing memory', async () => {
    await saveProjectMemory(home, 'keep')
    await expect(saveProjectMemory(home, 'x'.repeat(16001))).rejects.toThrow('16,000')
    expect(await readProjectMemory(home)).toBe('keep')
  })
  it('labels remembered notes as potentially stale in the system prompt', () => {
    const prompt = buildSystemPrompt({ cwd: home, toolNames: [], memory: 'Run npm test' })
    expect(prompt).toContain('potentially stale')
    expect(prompt).toContain('Run npm test')
  })
})
