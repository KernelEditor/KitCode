import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import type { PromptInputProps } from '../src/ui/types'
import type { Runtime } from '../src/ui/runtime'
import type { Message } from '../src/providers/types'

const captured = vi.hoisted(() => ({ prompt: null as PromptInputProps | null }))
vi.mock('../src/ui/components/PromptInput', () => ({ PromptInput: (props: PromptInputProps) => { captured.prompt = props; return null } }))
vi.mock('../src/ui/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../src/ui/components/Transcript', () => ({ Transcript: () => null }))
import { App } from '../src/ui/App'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60))

async function until(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

async function withApp(
  overrides: Record<string, unknown>,
  body: (stdin: PassThrough) => Promise<void>,
  history: Message[] = [],
) {
  const runtime = {
    cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
    modelContext: () => ({ window: null, used: 0, exact: false }), subscribeContext: () => () => {},
    startupUpdateCheck: async () => ({ status: 'current' }),
    getModelRef: () => 'test/model', getEffort: () => 'medium', getEffectiveEffort: () => 'medium', getThinking: () => false,
    usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal', getBell: () => false,
    isBypassEnabled: () => false, activeAgentsCount: () => 0, activeAgentsList: () => [],
    persist: async () => undefined, run: async () => [],
    ...overrides,
  } as unknown as Runtime
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 })
  const instance = render(<App runtime={runtime} initialHistory={history} />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
  try {
    await tick()
    await body(stdin)
  } finally {
    instance.cleanup()
    stdin.destroy()
    stdout.destroy()
    stderr.destroy()
  }
}

async function submit(line: string) {
  captured.prompt!.onSubmit(line)
  await tick()
}

describe('slash commands', () => {
  it('renames a session picked from the list when no id is given', async () => {
    const renameSession = vi.fn(async () => ({ id: 'x', title: 'Новое имя' }))
    let listed = false
    const listSessionItems = async () => {
      listed = true
      return [{ key: '2026-10-13T10-00-00-000Z-abc123', label: 'old chat' }]
    }
    await withApp({ renameSession, listSessionItems }, async (stdin) => {
      await submit('/sessions rename Новое имя')
      // Under a loaded parallel run the picker can take longer to appear.
      await until(() => listed)
      await tick()
      stdin.write('\r')
      await until(() => renameSession.mock.calls.length > 0)
    })
    expect(renameSession).toHaveBeenCalledWith('2026-10-13T10-00-00-000Z-abc123', 'Новое имя')
  })

  it('still takes an explicit session id', async () => {
    const renameSession = vi.fn(async () => ({ id: 'x', title: 'Title' }))
    const listSessionItems = async () => [
      { key: '2026-10-13T10-00-00-000Z-abc123', label: 'one' },
      { key: '2026-10-12T10-00-00-000Z-def456', label: 'two' },
    ]
    await withApp({ renameSession, listSessionItems }, async () => {
      await submit('/sessions rename def456 Title here')
    })
    expect(renameSession).toHaveBeenCalledWith('2026-10-12T10-00-00-000Z-def456', 'Title here')
  })

  it('selects a model, budget and language straight from the argument', async () => {
    const setModelRef = vi.fn(async () => undefined)
    const setMaxTokensPerTurn = vi.fn(async () => undefined)
    const setLang = vi.fn(async () => undefined)
    const listModelItems = async () => [
      { key: 'openai/gpt-mini', label: 'gpt-mini' },
      { key: 'anthropic/claude-big', label: 'claude-big' },
    ]
    await withApp(
      { setModelRef, listModelItems, setMaxTokensPerTurn, getMaxTokensPerTurn: () => 0, setLang },
      async () => {
        await submit('/model mini')
        await submit('/budget 500k')
        await submit('/lang ru')
      },
    )
    expect(setModelRef).toHaveBeenCalledWith('openai/gpt-mini')
    expect(setMaxTokensPerTurn).toHaveBeenCalledWith(500_000)
    expect(setLang).toHaveBeenCalledWith('ru')
  })

  it('does not flip a setting on a mistyped value', async () => {
    const setBell = vi.fn(async () => undefined)
    const setThinking = vi.fn(async () => undefined)
    await withApp({ setBell, setThinking }, async () => {
      await submit('/bell loud')
      await submit('/thinking yes')
      await submit('/thinking on')
    })
    expect(setBell).not.toHaveBeenCalled()
    expect(setThinking).toHaveBeenCalledTimes(1)
    expect(setThinking).toHaveBeenCalledWith(true)
  })

  it('inserts a saved prompt by name and asks before replacing one', async () => {
    const savePrompt = vi.fn(async () => 'review')
    await withApp(
      {
        promptExists: async (name: string) => name === 'Review',
        readPrompt: async () => 'Review the diff.',
        savePrompt,
      },
      async (stdin) => {
        await submit('/prompt Review')
        expect(captured.prompt!.value).toBe('Review the diff.')
        await submit('/prompt save Review')
        stdin.write('n')
        await tick()
        expect(savePrompt).not.toHaveBeenCalled()
        await submit('/prompt save Review')
        stdin.write('y')
        await tick()
      },
      [{ role: 'user', content: [{ type: 'text', text: 'Check the latest diff.' }] }],
    )
    expect(savePrompt).toHaveBeenCalledWith('Review', 'Check the latest diff.')
  })
})
