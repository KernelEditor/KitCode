import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../src/core/agent'
import type { Message } from '../src/providers/types'

const mocks = vi.hoisted(() => ({ run: vi.fn(), checks: vi.fn(), failSave: false }))
vi.mock('../src/config/store', async (original) => {
  const store = await original<typeof import('../src/config/store')>()
  return { ...store, saveConfig: async (config: Parameters<typeof store.saveConfig>[0]) => {
    if (mocks.failSave) throw new Error('disk full')
    await store.saveConfig(config)
  } }
})
vi.mock('../src/core/agent', async (original) => ({
  ...await original<typeof import('../src/core/agent')>(), runTurn: mocks.run,
}))
vi.mock('../src/core/diagnostics', () => ({ runAutomaticDiagnostics: mocks.checks }))
vi.mock('../src/providers/registry', () => ({ createRegistry: () => ({
  resolve: () => ({ provider: { kind: 'openai' }, modelId: 'test' }),
}) }))
const home = await mkdtemp(path.join(tmpdir(), 'kitcode-repairs-'))
process.env.KITCODE_HOME = home
const { boot } = await import('../src/app/runtime')
const { trustWorkspace } = await import('../src/config/trust')
const { configPath } = await import('../src/config/paths')
const { createSession, saveSession } = await import('../src/core/session')
const workspace = path.join(home, 'project')
await mkdir(path.join(workspace, '.kitcode'), { recursive: true })
await trustWorkspace(workspace)
afterAll(async () => {
  delete process.env.KITCODE_HOME
  await rm(home, { recursive: true, force: true })
})
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.failSave = false
  await writeFile(configPath, JSON.stringify({ version: 1 }))
  mocks.run.mockImplementation(async (_config: AgentConfig, history: Message[]) => [
    ...history, { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  ])
})
const hooks = { onEvent: vi.fn(), onHistory: vi.fn(), requestPermission: vi.fn() }
const report = (failed: boolean) => ({
  commands: ['test'], failed: failed ? ['test'] : [], skipped: false,
  results: [{ command: 'test', content: failed ? 'Expected 2, got 1' : 'All passed', isError: failed }],
})
it('does not retain a newly added optional setting when saving it fails', async () => {
  const app = await boot({ cwd: workspace })
  try {
    expect(app.runtime.getContextWindowOverride()).toBeUndefined()
    mocks.failSave = true
    await expect(app.runtime.setContextWindowOverride(500_000)).rejects.toThrow('disk full')
    expect(app.runtime.getContextWindowOverride()).toBeUndefined()
  } finally {
    mocks.failSave = false
    // The next successful save must neither inherit the failed option nor
    // leave the persistence queue stuck on the earlier rejection.
    await app.runtime.setThinking(false)
    await app.shutdown()
  }
  const reloaded = await boot({ cwd: workspace })
  try {
    expect(reloaded.runtime.getContextWindowOverride()).toBeUndefined()
    expect(reloaded.runtime.getThinking()).toBe(false)
  } finally { await reloaded.shutdown() }
})
it('rejects a foreign workspace on startup and session switch without replacing the active chat', async () => {
  const other = path.join(home, 'other-project')
  await mkdir(other, { recursive: true })
  const foreign = createSession(other, '')
  foreign.messages = [{ role: 'user', content: [{ type: 'text', text: 'other project' }] }]
  await saveSession(foreign)
  await expect(boot({ cwd: workspace, resumeId: foreign.id })).rejects.toThrow(/workspace/i)
  const app = await boot({ cwd: workspace })
  try {
    const id = app.runtime.sessionId()
    await expect(app.runtime.resumeSession(foreign.id)).rejects.toThrow(/workspace/i)
    expect(app.runtime.sessionId()).toBe(id)
    expect(app.runtime.cwd).toBe(workspace)
  } finally { await app.shutdown() }
})

it('resumes a session from the same directory even when its path contains dot segments', async () => {
  const stored = createSession(`${workspace}${path.sep}.${path.sep}`, '')
  stored.messages = [{ role: 'user', content: [{ type: 'text', text: 'same project' }] }]
  await saveSession(stored)
  const app = await boot({ cwd: workspace })
  try {
    expect(await app.runtime.resumeSession(stored.id)).toEqual(stored.messages)
  } finally { await app.shutdown() }
})
it('feeds failures back for repair and saves passing verification', async () => {
  mocks.checks.mockResolvedValueOnce(report(true)).mockResolvedValueOnce(report(false))
  const app = await boot({ cwd: workspace })
  try {
    const history = await app.runtime.run([], hooks, new AbortController().signal)
    expect(mocks.run).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(mocks.run.mock.calls[1][1])).toContain('Expected 2, got 1')
    expect(JSON.stringify(history)).toContain('All passed')
  } finally { await app.shutdown() }
})
it('bounds repairs when checks keep failing', async () => {
  mocks.checks.mockResolvedValue(report(true))
  const app = await boot({ cwd: workspace })
  try {
    await app.runtime.run([], hooks, new AbortController().signal)
    expect(mocks.run).toHaveBeenCalledTimes(3)
    expect(mocks.checks).toHaveBeenCalledTimes(3)
  } finally { await app.shutdown() }
})
it('loads and reloads trusted project instructions with a global config', async () => {
  mocks.checks.mockResolvedValue({ ...report(false), skipped: true })
  const file = path.join(workspace, '.kitcode', 'AGENTS.md')
  await writeFile(file, 'Project rule one')
  const app = await boot({ cwd: workspace })
  try {
    await app.runtime.run([], hooks, new AbortController().signal)
    expect(mocks.run.mock.calls[0][0].system).toContain('Project rule one')
    await writeFile(file, 'Project rule two')
    await app.runtime.run([], hooks, new AbortController().signal)
    expect(mocks.run.mock.calls[1][0].system).toContain('Project rule two')
    expect(mocks.run.mock.calls[1][0].system).not.toContain('Project rule one')
  } finally { await app.shutdown() }
})
