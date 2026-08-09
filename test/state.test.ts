import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Message } from '../src/providers/types'

const isWindows = process.platform === 'win32'

const home = await mkdtemp(path.join(tmpdir(), 'kitcode-state-'))
process.env.KITCODE_HOME = home

const { promptsDir, sessionsDir } = await import('../src/config/paths')
const {
  sanitizeHistory,
  createSession,
  saveSession,
  loadSession,
  listSessions,
  renameSession,
  deleteSession,
  deleteAllSessions,
  exportSession,
} = await import('../src/core/session')
const { getPrompt, listPrompts, savePrompt, searchPrompts, deletePrompt } = await import(
  '../src/prompts/library'
)
const { contextTokens, createUsageTracker, formatUsageCompact } = await import('../src/core/usage')

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const assistant = (...content: Message['content']): Message => ({ role: 'assistant', content })
const user = (...content: Message['content']): Message => ({ role: 'user', content })

describe('sanitizeHistory', () => {
  it('drops a tool_use with no later tool_result', () => {
    const history = sanitizeHistory([
      user({ type: 'text', text: 'list files' }),
      assistant(
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      ),
    ])

    expect(history).toHaveLength(2)
    expect(history[1].content).toEqual([{ type: 'text', text: 'looking' }])
  })

  it('keeps a tool_use answered by a later tool_result', () => {
    const messages = [
      user({ type: 'text', text: 'list files' }),
      assistant({ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } }),
      user({ type: 'tool_result', toolUseId: 'call_1', content: 'src' }),
    ]

    expect(sanitizeHistory(messages)).toEqual(messages)
  })

  it('drops the trailing assistant message left empty', () => {
    const history = sanitizeHistory([
      user({ type: 'text', text: 'go' }),
      assistant({ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }),
    ])

    expect(history).toEqual([user({ type: 'text', text: 'go' })])
  })

  it('drops an assistant message left empty in the middle of the history', () => {
    const history = sanitizeHistory([
      user({ type: 'text', text: 'go' }),
      assistant({ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }),
      user({ type: 'text', text: 'never mind, do this instead' }),
    ])

    expect(history).toEqual([
      user({ type: 'text', text: 'go' }),
      user({ type: 'text', text: 'never mind, do this instead' }),
    ])
  })

  it('keeps the answered half of a partially cancelled tool batch', () => {
    const history = sanitizeHistory([
      user({ type: 'text', text: 'go' }),
      assistant(
        { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
        { type: 'tool_use', id: 'call_2', name: 'bash', input: {} },
      ),
      user({ type: 'tool_result', toolUseId: 'call_1', content: 'done' }),
    ])

    expect(history[1].content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: {} },
    ])
    expect(history).toHaveLength(3)
  })
})

describe('prompt library', () => {
  it('treats a missing prompts directory as empty', async () => {
    expect(await listPrompts()).toEqual([])
  })

  it('round-trips frontmatter and body', async () => {
    const saved = await savePrompt({
      name: 'Review PR',
      description: 'Check the diff for regressions',
      body: 'Read the diff.\n\nThen: report only real bugs.',
    })

    expect(saved.slug).toBe('review-pr')

    const loaded = await getPrompt('review-pr')
    expect(loaded).toEqual(saved)
  })

  it('reads a prompt whose frontmatter is partial or noisy', async () => {
    await savePrompt({ name: 'Ship it', body: 'Deploy carefully.' })
    await writeFile(
      path.join(promptsDir, 'ship-it.md'),
      ['---', 'name: Ship it', 'nonsense', 'colour: red', '---', '', 'Deploy carefully.', ''].join(
        '\n',
      ),
      'utf8',
    )

    expect(await getPrompt('ship-it')).toEqual({
      slug: 'ship-it',
      name: 'Ship it',
      description: '',
      created: '',
      body: 'Deploy carefully.',
    })
  })

  it('overwrites by slug, sorts by name, searches and deletes', async () => {
    await savePrompt({ name: 'Ship it', description: 'release', body: 'Deploy carefully.' })
    await savePrompt({ name: 'Ship it', description: 'release', body: 'Deploy boldly.' })

    const names = (await listPrompts()).map((prompt) => prompt.name)
    expect(names).toEqual(['Review PR', 'Ship it'])
    expect((await getPrompt('ship-it'))?.body).toBe('Deploy boldly.')

    expect((await searchPrompts('RELEASE')).map((prompt) => prompt.slug)).toEqual(['ship-it'])
    expect(await deletePrompt('ship-it')).toBe(true)
    expect(await deletePrompt('ship-it')).toBe(false)
  })

  it('rejects path traversal ids and stores prompts privately', async () => {
    const saved = await savePrompt({ name: 'Private prompt', body: 'hello' })
    await expect(getPrompt('../auth')).rejects.toThrow(/Invalid prompt id/)
    await expect(deletePrompt('../../config')).rejects.toThrow(/Invalid prompt id/)
    if (!isWindows) {
      expect((await stat(path.join(promptsDir, `${saved.slug}.md`))).mode & 0o777).toBe(0o600)
    }
  })
})

describe('usage tracker', () => {
  const known = 'anthropic/claude-sonnet-5'
  const unknown = 'mystery/model-x'
  const usage = { input: 1000, output: 500, cacheWrite: 200, cacheRead: 4000 }

  it('prices what it can and reports unknown models as null', () => {
    const tracker = createUsageTracker()
    tracker.record(known, usage)
    tracker.record(unknown, usage)

    const entries = tracker.entries()
    const knownEntry = entries.find((entry) => entry.model === known)
    const unknownEntry = entries.find((entry) => entry.model === unknown)

    expect(unknownEntry?.costUsd).toBeNull()
    expect(knownEntry?.costUsd).toBeGreaterThan(0)
    expect(tracker.totals().costUsd).toBe(knownEntry?.costUsd)
  })

  it('reports a null total when nothing can be priced', () => {
    const tracker = createUsageTracker()
    tracker.record(unknown, usage)

    expect(tracker.totals()).toEqual({ usage, costUsd: null, requests: 1 })
  })

  it('formats a status bar line, omitting the cost when nothing can be priced', () => {
    const priced = createUsageTracker()
    priced.record(known, { input: 12400, output: 3100, cacheWrite: 200, cacheRead: 8000 })
    expect(formatUsageCompact(priced)).toBe('12.4k↑ 3.1k↓ (8.2k cache) · $0.09')

    const unpriced = createUsageTracker()
    unpriced.record(unknown, { input: 12400, output: 3100, cacheWrite: 200, cacheRead: 8000 })
    expect(formatUsageCompact(unpriced)).toBe('12.4k↑ 3.1k↓ (8.2k cache)')
  })

  it('folds repeated records per model and resets', () => {
    const tracker = createUsageTracker()
    tracker.record(unknown, usage)
    tracker.record(unknown, usage)

    expect(tracker.entries()).toHaveLength(1)
    expect(tracker.totals()).toMatchObject({
      requests: 2,
      usage: { input: 2000, output: 1000, cacheWrite: 400, cacheRead: 8000 },
    })

    tracker.reset()
    expect(tracker.entries()).toEqual([])
    expect(tracker.totals()).toEqual({
      usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      costUsd: null,
      requests: 0,
    })
  })

  it('restore() replaces the totals with the resumed session entries', () => {
    
    
    
    const tracker = createUsageTracker([
      { model: 'a/model', usage, requests: 1 },
    ])
    expect(tracker.totals()).toMatchObject({ requests: 1, usage })

    tracker.restore([
      { model: 'other/model', usage: { input: 500, output: 250, cacheWrite: 0, cacheRead: 0 }, requests: 3 },
    ])
    expect(tracker.entries()).toEqual([
      expect.objectContaining({ model: 'other/model', requests: 3 }),
    ])
    expect(tracker.totals()).toMatchObject({
      requests: 3,
      usage: { input: 500, output: 250, cacheWrite: 0, cacheRead: 0 },
    })
  })

  it('measures one context request instead of cumulative session usage', () => {
    expect(contextTokens(usage)).toBe(5700)
  })
})

describe('saveSession', () => {
  it('rejects traversal in a direct session id', async () => {
    await expect(loadSession('../../auth')).rejects.toThrow(/Invalid session id/)
  })

  it('round-trips the exact usage behind the context meter', async () => {
    const session = createSession('/tmp', 'provider/model')
    session.context = {
      model: 'provider/model',
      usage: { input: 100, output: 20, cacheWrite: 30, cacheRead: 400 },
    }

    await saveSession(session)
    expect((await loadSession(session.id)).context).toEqual(session.context)
    if (!isWindows) {
      expect((await stat(path.join(sessionsDir, `${session.id}.json`))).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects malformed message blocks instead of trusting a session cast', async () => {
    const session = createSession('/tmp', 'provider/model')
    await saveSession(session)
    await writeFile(
      path.join(sessionsDir, `${session.id}.json`),
      JSON.stringify({ ...session, messages: [{ role: 'assistant', content: [{ type: 'text', text: 42 }] }] }),
      'utf8',
    )
    await expect(loadSession(session.id)).rejects.toThrow(/not readable as a session/)
    expect((await listSessions(100)).some((entry) => entry.id === session.id)).toBe(false)
  })

  it('concurrent writes for the same session both finish without clobbering', async () => {
    const session = createSession('/tmp', 'provider/model')
    session.messages = [{ role: 'user', content: [{ type: 'text', text: 'seed' }] }]
    
    
    const [a, b] = await Promise.all([
      saveSession({ ...session, messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }] }),
      saveSession({ ...session, messages: [{ role: 'user', content: [{ type: 'text', text: 'B' }] }] }),
    ])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    const loaded = await loadSession(session.id)
    expect(loaded.messages[0].content[0]).toMatchObject({
      type: 'text',
      
      text: expect.stringMatching(/^[AB]$/),
    })
  })

  it('renames, lists, exports and deletes a session without exporting raw images or thinking', async () => {
    const session = createSession('/tmp/project', 'provider/model')
    session.messages = [
      user(
        { type: 'text', text: 'Use key sk-export-secret-1234567890 carefully' },
        { type: 'image', mediaType: 'image/png', data: 'very-large-base64', name: 'screen.png' },
      ),
      assistant(
        { type: 'thinking', text: 'private reasoning' },
        { type: 'text', text: 'Done.' },
      ),
    ]
    await saveSession(session)

    const renamed = await renameSession(session.id, 'Release review')
    expect(renamed.title).toBe('Release review')
    expect((await listSessions(100)).find((entry) => entry.id === session.id)?.title).toBe(
      'Release review',
    )

    const exported = await exportSession(session.id, home)
    const markdown = await readFile(exported.path, 'utf8')
    expect(markdown).toContain('# Release review')
    expect(markdown).toContain('[Image attached: screen.png]')
    expect(markdown).toContain('[redacted]')
    expect(markdown).not.toContain('very-large-base64')
    expect(markdown).not.toContain('private reasoning')
    if (!isWindows) {
      expect((await stat(exported.path)).mode & 0o777).toBe(0o600)
    }

    expect(await deleteSession(session.id)).toBe(session.id)
    await expect(loadSession(session.id)).rejects.toThrow(/No session found/)
  })

  it('keeps exported Markdown valid around metadata and attached file contents', async () => {
    const session = createSession('/tmp/project_[draft]', 'provider/model_*')
    session.title = 'Release *review* [draft]'
    session.messages = [
      user({
        type: 'file',
        mediaType: 'text/plain',
        name: 'notes [draft].md',
        text: 'before\n```\nafter',
      }),
    ]
    await saveSession(session)

    const exported = await exportSession(session.id, home)
    const markdown = await readFile(exported.path, 'utf8')
    expect(markdown).toContain('# Release \\*review\\* \\[draft\\]')
    expect(markdown).toContain('- Workspace: /tmp/project\\_\\[draft\\]')
    expect(markdown).toContain('- Model: provider/model\\_\\*')
    expect(markdown).toContain('[File attached: notes \\[draft\\].md]')
    expect(markdown).toContain('~~~\nbefore\n```\nafter\n~~~')

    expect(await deleteSession(session.id)).toBe(session.id)
  })

  it('deletes every session file without touching unrelated files', async () => {
    const first = createSession('/tmp/one', 'provider/model')
    const second = createSession('/tmp/two', 'provider/model')
    await Promise.all([saveSession(first), saveSession(second)])
    const unrelated = path.join(sessionsDir, 'keep.txt')
    await writeFile(unrelated, 'keep', 'utf8')

    const result = await deleteAllSessions()
    expect(result.failed).toEqual([])
    expect(result.deleted).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(await listSessions(100)).toEqual([])
    await expect(stat(unrelated)).resolves.toBeDefined()
  })
})
