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
async function withApp(body: (io: { stdin: PassThrough; stdout: PassThrough & NodeJS.WriteStream; output(): string }) => Promise<void>, overrides: Record<string, unknown> = {}) {
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
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'OLD_CHAT_MARKER' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OLD_ANSWER_MARKER' }] },
  ]
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 60 })
  let output = ''
  stdout.on('data', (chunk) => { output += chunk.toString() })
  const app = render(<App runtime={runtime} initialHistory={history} />, { stdin, stdout, stderr, interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 0, incrementalRendering: false })
  try { await tick(); await body({ stdin, stdout, output: () => output }) }
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
