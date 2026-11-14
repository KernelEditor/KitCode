import { PassThrough } from 'node:stream'
import { Text, render } from 'ink'
import { expect, it, vi } from 'vitest'
import type { PromptInputProps } from '../src/ui/types'
import type { Runtime } from '../src/ui/runtime'
import type { Message } from '../src/providers/types'
import type { AgentHooks } from '../src/core/types'
import { terminalScreen } from './fixtures/terminal-screen'

const captured = vi.hoisted(() => ({ realPrompt: false, prompt: null as PromptInputProps | null, onboarding: null as { onSubmit(url: string, key: string): Promise<string>; onCancel(): void } | null }))
vi.mock('../src/ui/components/PromptInput', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ui/components/PromptInput')>()
  return { PromptInput: (props: PromptInputProps) => {
    captured.prompt = props
    return captured.realPrompt ? <original.PromptInput {...props} /> : <Text>input footer</Text>
  } }
})
vi.mock('../src/ui/components/StatusBar', () => ({ StatusBar: () => <Text>status footer</Text> }))
vi.mock('../src/ui/components/Onboarding', () => ({ Onboarding: (props: NonNullable<typeof captured.onboarding>) => { captured.onboarding = props; return <Text>provider setup</Text> } }))
import { App } from '../src/ui/App'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 80))
async function withApp(body: (io: { stdin: PassThrough; stdout: PassThrough & NodeJS.WriteStream; output(): string; flush(): Promise<void> }) => Promise<void>, overrides: Record<string, unknown> = {}, initialHistory?: Message[], slowOutput = false) {
  const runtime = {
    cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
    modelContext: () => ({ window: null, used: 0, exact: false }), subscribeContext: () => () => {},
    startupUpdateCheck: async () => ({ status: 'current' }),
    getModelRef: () => 'test/model', getEffort: () => 'medium', getEffectiveEffort: () => 'medium', getThinking: () => false,
    usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal', getBell: () => false,
    isBypassEnabled: () => false, activeAgentsList: () => [], persist: async () => {}, run: async () => [], newSession: async () => {},
    addProvider: async () => 'provider added', configPath: () => 'config',
    ...overrides,
  } as unknown as Runtime
  const history: Message[] = initialHistory ?? [
    { role: 'user', content: [{ type: 'text', text: 'OLD_CHAT_MARKER' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OLD_ANSWER_MARKER' }] },
  ]
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough(slowOutput ? {
    transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 3) },
  } : {}) as PassThrough & NodeJS.WriteStream
  const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 60 })
  let output = ''
  stdout.on('data', (chunk) => { output += chunk.toString() })
  const app = render(<App runtime={runtime} initialHistory={history} />, { stdin, stdout, stderr, interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 0, incrementalRendering: false })
  try { await tick(); await app.waitUntilRenderFlush(); await body({ stdin, stdout, output: () => output, flush: () => app.waitUntilRenderFlush() }) }
  finally { app.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy() }
}

it.each(['cancel', 'add'] as const)('does not replay the cat or chat after provider setup: %s', async (action) => {
  await withApp(async ({ output }) => {
    expect(output()).toContain('OLD_CHAT_MARKER')
    const start = output().length
    captured.prompt!.onSubmit('/login')
    await tick()
    if (action === 'cancel') captured.onboarding!.onCancel()
    else await captured.onboarding!.onSubmit('https://example.com', 'test-key')
    await tick()
    expect(output().slice(start)).not.toContain('OLD_CHAT_MARKER')
    expect(output().slice(start)).not.toContain('kitcode')
  })
})

it('clears terminal scrollback and never replays the old chat on resize', async () => {
  await withApp(async ({ stdout, output }) => {
    captured.prompt!.onSubmit('/clear')
    await tick()
    const clear = output().lastIndexOf('\x1b[3J')
    expect(clear).toBeGreaterThanOrEqual(0)
    stdout.rows = 10
    stdout.emit('resize')
    await tick()
    stdout.rows = 60
    stdout.emit('resize')
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const after = output().slice(output().lastIndexOf('\x1b[3J'))
    expect(after).not.toContain('OLD_CHAT_MARKER')
    expect(after).not.toContain('OLD_ANSWER_MARKER')
    expect(after.match(/kitcode/g)).toHaveLength(1)
  })
})

it('redraws a single prompt after a burst of width and height changes without losing the draft', async () => {
  captured.realPrompt = true
  try {
    await withApp(async ({ stdout, output }) => {
      captured.prompt!.onChange('DRAFT_MARKER keep this text')
      await tick()
      const start = output().length
      for (const [columns, rows] of [[65, 20], [40, 12], [110, 50], [48, 16], [80, 30]]) {
        stdout.columns = columns!
        stdout.rows = rows!
        stdout.emit('resize')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      const redraws = output().slice(start).split('\x1b[3J')
      expect(redraws).toHaveLength(2)
      const screen = terminalScreen(redraws.at(-1)!, stdout.columns, stdout.rows)
      expect(screen.match(/╭/g)).toHaveLength(1)
      expect(screen.match(/kitcode/g)).toHaveLength(1)
      expect(screen.match(/OLD_CHAT_MARKER/g)).toHaveLength(1)
      expect(screen.match(/DRAFT_MARKER/g)).toHaveLength(1)
      expect(captured.prompt!.value).toBe('DRAFT_MARKER keep this text')
    })
  } finally { captured.realPrompt = false }
})

it('does not reset the screen on duplicate resize events with unchanged dimensions', async () => {
  await withApp(async ({ stdout, output }) => {
    const start = output().length
    stdout.emit('resize')
    stdout.emit('resize')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(output().slice(start)).not.toContain('\x1b[3J')
  })
})

it('serializes a resize redraw with /clear and keeps the new session empty', async () => {
  await withApp(async ({ stdout, output }) => {
    stdout.columns = 50
    stdout.emit('resize')
    captured.prompt!.onSubmit('/clear')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const lastClear = output().lastIndexOf('\x1b[3J')
    const screen = terminalScreen(output().slice(lastClear), stdout.columns, stdout.rows)
    expect(screen).not.toContain('OLD_CHAT_MARKER')
    expect(screen).not.toContain('already suspended')
    expect(screen.match(/kitcode/g)).toHaveLength(1)
  })
})

it('preserves streamed text arriving during resize redraws', async () => {
  let hooks!: AgentHooks
  let finish!: () => void
  const run = async (history: Message[], current: AgentHooks) => {
    hooks = current
    await new Promise<void>((resolve) => { finish = resolve })
    return history
  }
  await withApp(async ({ stdout, output }) => {
    captured.prompt!.onSubmit('start')
    await tick()
    try {
      hooks.onEvent({ type: 'text_delta', text: 'BEFORE ' })
      stdout.columns = 50
      stdout.emit('resize')
      await tick()
      hooks.onEvent({ type: 'text_delta', text: 'DURING ' })
      await tick()
      hooks.onEvent({ type: 'text_delta', text: 'AFTER' })
      hooks.onEvent({ type: 'turn_end', stopReason: 'end_turn' })
      await new Promise((resolve) => setTimeout(resolve, 250))
      const lastClear = output().lastIndexOf('\x1b[3J')
      const screen = terminalScreen(output().slice(lastClear), stdout.columns, stdout.rows)
      expect(screen).toContain('BEFORE DURING AFTER')
      expect(screen.match(/kitcode/g)).toHaveLength(1)
    } finally { finish(); await tick() }
  }, { run })
})

it.each(['/resume', '/sessions resume other'])('replaces scrollback rather than appending another session with %s', async (command) => {
  await withApp(async ({ stdin, stdout, output }) => {
    const start = output().length
    captured.prompt!.onSubmit(command)
    await tick()
    if (command === '/resume') { stdin.write('\r'); await tick() }
    await tick()
    const clear = output().lastIndexOf('\x1b[3J')
    expect(clear).toBeGreaterThan(start)
    const after = output().slice(clear)
    expect(after).not.toContain('OLD_CHAT_MARKER')
    expect(after.match(/RESTORED_MARKER/g)).toHaveLength(1)
    expect(after.match(/kitcode/g)).toHaveLength(1)
    const end = output().length
    stdout.columns = 80
    stdout.emit('resize')
    await tick()
    expect(output().slice(end)).not.toContain('OLD_CHAT_MARKER')
  }, {
    listSessionItems: async () => [{ key: 'other', label: 'other session' }],
    resumeSession: async () => [{ role: 'user', content: [{ type: 'text', text: 'RESTORED_MARKER' }] }],
  })
})

it.each(['/clear', '/resume', '/sessions resume other'])('removes a long chat from the full scrollback with %s, including after resize', async (command) => {
  const longHistory = (prefix: string): Message[] => Array.from({ length: 70 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `${prefix}_${String(index).padStart(2, '0')} ${'wrapped text '.repeat(12)}` }],
  }))
  const restored = longHistory('RESTORED_SCROLL_ROW')
  await withApp(async ({ stdin, stdout, output }) => {
    // Check the interpreted viewport AND saved lines, not just writes after
    // the last erase sequence: this is what scrolling up exposes to the user.
    const before = terminalScreen(output(), stdout.columns, stdout.rows)
    expect(before).toContain('OLD_SCROLL_ROW_00')
    expect(before.split('\n').length).toBeGreaterThan(stdout.rows)

    captured.prompt!.onSubmit(command)
    await tick()
    if (command === '/resume') { stdin.write('\r'); await tick() }
    await tick()

    const checkScrollback = () => {
      const screen = terminalScreen(output(), stdout.columns, stdout.rows)
      expect(screen).not.toContain('OLD_SCROLL_ROW_')
      expect(screen.match(/kitcode/g)).toHaveLength(1)
      if (command === '/clear') expect(screen).not.toContain('RESTORED_SCROLL_ROW_')
      else {
        expect(screen.match(/RESTORED_SCROLL_ROW_00/g)).toHaveLength(1)
        expect(screen.match(/RESTORED_SCROLL_ROW_69/g)).toHaveLength(1)
      }
    }
    checkScrollback()
    for (const [columns, rows] of [[45, 20], [100, 60]]) {
      stdout.columns = columns!
      stdout.rows = rows!
      stdout.emit('resize')
      await new Promise((resolve) => setTimeout(resolve, 250))
      checkScrollback()
    }

    // The restored conversation must not return after a subsequent /clear.
    captured.prompt!.onSubmit('/clear')
    await tick()
    const cleared = terminalScreen(output(), stdout.columns, stdout.rows)
    expect(cleared).not.toContain('OLD_SCROLL_ROW_')
    expect(cleared).not.toContain('RESTORED_SCROLL_ROW_')
  }, {
    listSessionItems: async () => [{ key: 'other', label: 'other session' }],
    resumeSession: async () => restored,
  }, longHistory('OLD_SCROLL_ROW'))
})

it.each(['/clear', '/sessions resume other'])('does not bring back a finishing answer after queued %s', async (command) => {
  let hooks!: AgentHooks
  let finish!: () => void
  const completion = new Promise<void>((resolve) => { finish = resolve })
  const restored: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'RESTORED_MARKER' }] }]
  const run = vi.fn(async (history: Message[], current: AgentHooks) => {
    if (run.mock.calls.length > 1) return history
    hooks = current
    await completion
    hooks.onEvent({ type: 'text_delta', text: 'OLD_FINAL_MARKER' })
    hooks.onEvent({ type: 'turn_end', stopReason: 'end_turn' })
    const next: Message[] = [...history, { role: 'assistant', content: [{ type: 'text', text: 'OLD_STREAM_MARKER OLD_FINAL_MARKER' }] }]
    hooks.onHistory?.(next)
    return next
  })
  try {
    await withApp(async ({ stdout, output, flush }) => {
      captured.prompt!.onSubmit('start')
      await tick()
      // Leave a delta waiting on the 50 ms timer while the session switch
      // queues behind the running answer. Finish and resize in the same turn.
      hooks.onEvent({ type: 'text_delta', text: 'OLD_STREAM_MARKER ' })
      captured.prompt!.onSubmit(command)
      finish()
      stdout.columns = 70
      stdout.emit('resize')
      await new Promise((resolve) => setTimeout(resolve, 350))
      await flush()
      const screen = terminalScreen(output(), stdout.columns, stdout.rows)
      expect(screen).not.toMatch(/OLD_(?:CHAT|ANSWER|STREAM|FINAL)_MARKER/)
      if (command !== '/clear') expect(screen).toContain('RESTORED_MARKER')

      captured.prompt!.onSubmit('AFTER_SWITCH')
      await tick()
      await flush()
      const nextHistory = run.mock.calls[1]![0]
      expect(JSON.stringify(nextHistory)).not.toContain('OLD_')
      expect(nextHistory).toHaveLength(command === '/clear' ? 1 : 2)
    }, {
      run,
      listSessionItems: async () => [{ key: 'other', label: 'other session' }],
      resumeSession: async () => restored,
    })
  } finally { finish() }
})

it('serializes resume, clear and a new message while terminal writes are delayed', async () => {
  const run = vi.fn(async (history: Message[]) => history)
  const newSession = vi.fn(async () => {})
  captured.realPrompt = true
  try {
    await withApp(async ({ stdout, output, flush }) => {
      captured.prompt!.onSubmit('/sessions resume other')
      captured.prompt!.onSubmit('/clear')
      captured.prompt!.onSubmit('AFTER_SLOW_CLEAR')
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 3000 })
      await flush()
      const screen = terminalScreen(output(), stdout.columns, stdout.rows)
      expect(screen).not.toMatch(/OLD_(?:CHAT|ANSWER)_MARKER|RESTORED_MARKER/)
      expect(screen.match(/AFTER_SLOW_CLEAR/g)).toHaveLength(1)
      expect(screen.match(/kitcode/g)).toHaveLength(1)
      expect(newSession).toHaveBeenCalledOnce()
      expect(run.mock.calls[0]![0]).toEqual([{ role: 'user', content: [{ type: 'text', text: 'AFTER_SLOW_CLEAR' }] }])
    }, {
      run, newSession,
      listSessionItems: async () => [{ key: 'other', label: 'other session' }],
      resumeSession: async () => [{ role: 'user', content: [{ type: 'text', text: 'RESTORED_MARKER' }] }],
    }, undefined, true)
  } finally { captured.realPrompt = false }
})

it('prints one fresh header after deleting the active provider and returning from setup', async () => {
  let needsSetup = false
  await withApp(async ({ stdin, output }) => {
    const start = output().length
    captured.prompt!.onSubmit('/logout test')
    await tick()
    stdin.write('y')
    await tick()
    await tick()
    const clear = output().lastIndexOf('\x1b[3J')
    expect(clear).toBeGreaterThan(start)
    await captured.onboarding!.onSubmit('https://example.com', 'test-key')
    await tick()
    const after = output().slice(clear)
    expect(after).not.toContain('OLD_CHAT_MARKER')
    expect(after.match(/kitcode/g)).toHaveLength(1)
  }, {
    needsSetup: () => needsSetup,
    listProviderItems: () => [{ key: 'test', label: 'test' }],
    logout: async () => { needsSetup = true; return { removed: 'test', wasActive: true } },
    addProvider: async () => { needsSetup = false; return 'provider added' },
  })
})

it('replaces static output after context compaction', async () => {
  await withApp(async ({ output }) => {
    const start = output().length
    captured.prompt!.onSubmit('/compact')
    await tick()
    await tick()
    const clear = output().lastIndexOf('\x1b[3J')
    expect(clear).toBeGreaterThan(start)
    const after = output().slice(clear)
    expect(after).not.toContain('OLD_CHAT_MARKER')
    expect(after.match(/COMPACTED_MARKER/g)).toHaveLength(1)
    expect(after.match(/kitcode/g)).toHaveLength(1)
  }, { compact: async () => ({ compacted: true, removedMessages: 2, history: [{ role: 'user', content: [{ type: 'text', text: 'COMPACTED_MARKER' }] }] }) })
})
