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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

describe('esc while an answer is running', () => {
  it('clears a typed draft first and cancels the answer only on the next esc', async () => {
    let complete!: (history: Message[]) => void
    const completion = new Promise<Message[]>((resolve) => { complete = resolve })
    const run = vi.fn(() => completion)
    const runtime = {
      cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
      modelContext: () => null, subscribeContext: () => () => {},
      startupUpdateCheck: async () => ({ status: 'current' }),
      getModelRef: () => 'test/model', getEffort: () => 'medium', getEffectiveEffort: () => 'medium', getThinking: () => false,
      usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal', getBell: () => false,
      isBypassEnabled: () => false, activeAgentsCount: () => 0, activeAgentsList: () => [],
      persist: async () => undefined, run,
    } as unknown as Runtime
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 })
    const instance = render(<App runtime={runtime} initialHistory={[]} />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
    try {
      await tick()
      captured.prompt!.onSubmit('work')
      await tick()
      const [, , signal] = run.mock.calls[0] as unknown as [Message[], unknown, AbortSignal]
      captured.prompt!.onChange('half-typed follow-up')
      await tick()
      expect(captured.prompt!.hint).toContain('clears the input')
      stdin.write('\u001b')
      await tick()
      expect(captured.prompt!.value).toBe('')
      expect(signal.aborted).toBe(false)
      stdin.write('\u001b')
      await tick()
      expect(signal.aborted).toBe(true)
    } finally {
      complete([])
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })
})

describe('editing queued messages', () => {
  it('takes out one queued message at a time and puts edits back in place', async () => {
    let complete!: (history: Message[]) => void
    const completion = new Promise<Message[]>((resolve) => { complete = resolve })
    const run = vi.fn(() => completion)
    const runtime = {
      cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
      modelContext: () => null, subscribeContext: () => () => {},
      startupUpdateCheck: async () => ({ status: 'current' }),
      getModelRef: () => 'test/model', getEffort: () => 'medium', getEffectiveEffort: () => 'medium', getThinking: () => false,
      usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal', getBell: () => false,
      isBypassEnabled: () => false, activeAgentsCount: () => 0, activeAgentsList: () => [],
      persist: async () => undefined, run,
    } as unknown as Runtime
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 })
    const instance = render(<App runtime={runtime} initialHistory={[]} />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
    const prompt = () => captured.prompt!
    try {
      await tick()
      prompt().onSubmit('work')
      await tick()
      for (const text of ['a', 'b', 'c']) {
        prompt().onSubmit(text)
        await tick()
      }
      expect(prompt().queued).toEqual(['a', 'b', 'c'])

      // ↑ takes only the newest one out; the rest keep waiting.
      expect(prompt().onNavigateQueue!('previous', '')).toBe('c')
      await tick()
      expect(prompt().queued).toEqual(['a', 'b'])

      // Moving on puts the edited text back in its place and takes the neighbour.
      expect(prompt().onNavigateQueue!('previous', 'c edited')).toBe('b')
      await tick()
      expect(prompt().queued).toEqual(['a', 'c edited'])
      expect(prompt().onNavigateQueue!('next', 'b')).toBe('c edited')
      await tick()
      expect(prompt().onNavigateQueue!('next', 'c edited')).toBe('')
      await tick()
      expect(prompt().queued).toEqual(['a', 'b', 'c edited'])

      // Enter on a taken-out message returns it to the same position.
      expect(prompt().onNavigateQueue!('previous', '')).toBe('c edited')
      expect(prompt().onNavigateQueue!('previous', 'c edited')).toBe('b')
      prompt().onSubmit('b2')
      await tick()
      expect(prompt().queued).toEqual(['a', 'b2', 'c edited'])

      // Esc while editing a queued message leaves the edit, not the answer.
      expect(prompt().onNavigateQueue!('previous', '')).toBe('c edited')
      prompt().onChange('c final')
      await tick()
      stdin.write('\u001b')
      await tick()
      expect(prompt().queued).toEqual(['a', 'b2', 'c final'])
      expect(prompt().value).toBe('')
      expect(prompt().hint).toBeDefined()
      const [, , signal] = run.mock.calls[0] as unknown as [Message[], unknown, AbortSignal]
      expect(signal.aborted).toBe(false)
    } finally {
      complete([])
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })
})
