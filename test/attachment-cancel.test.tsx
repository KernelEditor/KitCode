import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import type { PromptInputProps } from '../src/ui/types'
import type { Runtime } from '../src/ui/runtime'
import type { ContentBlock, Message } from '../src/providers/types'

const captured = vi.hoisted(() => ({ prompt: null as PromptInputProps | null }))
vi.mock('../src/ui/components/PromptInput', () => ({ PromptInput: (props: PromptInputProps) => { captured.prompt = props; return null } }))
vi.mock('../src/ui/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('../src/ui/components/Transcript', () => ({ Transcript: () => null }))
import { App } from '../src/ui/App'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

describe('attachment cancellation', () => {
  it('runs status commands while busy and preserves a new draft when queued commands drain', async () => {
    let complete!: (history: Message[]) => void
    const completion = new Promise<Message[]>((resolve) => { complete = resolve })
    const activeAgentsList = vi.fn(() => [])
    const newSession = vi.fn(async () => undefined)
    const runtime = {
      cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
      modelContext: () => null, subscribeContext: () => () => {},
      startupUpdateCheck: async () => ({ status: 'current' }),
      getModelRef: () => 'test/model', getEffort: () => 'medium', getThinking: () => false,
      usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal',
      isBypassEnabled: () => false, activeAgentsCount: () => 0,
      persist: async () => undefined, run: () => completion, activeAgentsList, newSession,
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
      captured.prompt!.onSubmit('/subagents')
      await tick()
      expect(activeAgentsList).toHaveBeenCalledOnce()
      captured.prompt!.onSubmit('/clear')
      await tick()
      expect(newSession).not.toHaveBeenCalled()
      captured.prompt!.onChange('next draft')
      await tick()
      complete([])
      await tick()
      expect(newSession).toHaveBeenCalledOnce()
      expect(captured.prompt!.value).toBe('next draft')
    } finally {
      complete([])
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })

  it('persists a submitted user message even when the provider fails', async () => {
    const persist = vi.fn(async () => undefined)
    const run = vi.fn(async () => {
      throw new Error('balance exhausted')
    })
    const runtime = {
      cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
      modelContext: () => null, subscribeContext: () => () => {},
      startupUpdateCheck: async () => ({ status: 'current' }),
      getModelRef: () => 'test/model', getEffort: () => 'medium', getThinking: () => false,
      usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal',
      isBypassEnabled: () => false, activeAgentsCount: () => 0, persist, run,
    } as unknown as Runtime
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 })
    const instance = render(<App runtime={runtime} initialHistory={[]} />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
    try {
      await tick()
      captured.prompt!.onSubmit('keep this after failure')
      await tick()
      expect(run).toHaveBeenCalledOnce()
      expect(persist).toHaveBeenCalledWith([
        { role: 'user', content: [{ type: 'text', text: 'keep this after failure' }] },
      ])
    } finally {
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })

  it.each(['path', 'clipboard'] as const)('does not restore a cancelled %s attachment or send a waiting message', async (kind) => {
    let finish!: (block: ContentBlock) => void
    const pending = new Promise<ContentBlock>((resolve) => { finish = resolve })
    const run = vi.fn(async (history) => history)
    const runtime = {
      cwd: process.cwd(), getAccent: () => 'purple', getLang: () => 'en', needsSetup: () => false,
      modelContext: () => null, subscribeContext: () => () => {},
      startupUpdateCheck: async () => ({ status: 'current' }),
      getModelRef: () => 'test/model', getEffort: () => 'medium', getThinking: () => false,
      usageParts: () => ({}), mcpSummary: () => ({}), getMode: () => 'normal',
      isBypassEnabled: () => false, activeAgentsCount: () => 0,
      loadAutomaticAttachment: () => pending, loadClipboardImage: () => pending, run,
    } as unknown as Runtime
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 })
    const instance = render(<App runtime={runtime} initialHistory={[]} />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
    try {
      await tick()
      if (kind === 'path') void captured.prompt!.onPastePath!('C:\\image.png')
      else captured.prompt!.onPasteImage!()
      captured.prompt!.onSubmit('message waiting for attachment')
      await tick()
      stdin.write('\u001b')
      await tick()
      finish({ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'image.png' })
      await tick()
      expect(captured.prompt!.attachments).toEqual([])
      expect(run).not.toHaveBeenCalled()
    } finally {
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })
})
