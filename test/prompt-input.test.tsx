import { PassThrough } from 'node:stream'
import { render } from 'ink'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PromptInput } from '../src/ui/components/PromptInput'

describe('slash command keyboard navigation', () => {
  it('moves with arrows and activates the selected command with enter', async () => {
    const submitted: string[] = []
    const terminal = renderPrompt((value) => submitted.push(value))
    try {
      await terminal.input('/')
      await terminal.input('\u001b[B')
      await terminal.input('\r')
      expect(submitted).toEqual(['/login'])
    } finally {
      terminal.cleanup()
    }
  })

  it('moves both directions and completes the selected command with tab', async () => {
    const changes: string[] = []
    const terminal = renderPrompt(vi.fn(), (value) => changes.push(value))
    try {
      await terminal.input('/')
      await terminal.input('\u001b[B')
      await terminal.input('\u001b[B')
      await terminal.input('\u001b[A')
      await terminal.input('\t')
      expect(changes.at(-1)).toBe('/login ')
    } finally {
      terminal.cleanup()
    }
  })

  it('keeps ordinary editing and enter submission working with a movable cursor', async () => {
    const submitted: string[] = []
    const changes: string[] = []
    const terminal = renderPrompt(
      (value) => submitted.push(value),
      (value) => changes.push(value),
    )
    try {
      await terminal.input('abc')
      await terminal.input('\u001b[D')
      await terminal.input('X')
      await terminal.input('\u007f')
      await terminal.input('\u001b[3~')
      await terminal.input('d')
      await terminal.input('\r')
      expect(changes.at(-1)).toBe('abd')
      expect(submitted).toEqual(['abd'])
    } finally {
      terminal.cleanup()
    }
  })
})

function renderPrompt(
  onSubmit: (value: string) => void,
  observeChange: (value: string) => void = () => undefined,
) {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: vi.fn(),
    ref: () => stdin,
    unref: () => stdin,
  })
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 })
  Object.assign(stderr, { isTTY: true, columns: 120, rows: 40 })

  function Harness() {
    const [value, setValue] = useState('')
    return (
      <PromptInput
        value={value}
        onChange={(next) => {
          setValue(next)
          observeChange(next)
        }}
        onSubmit={onSubmit}
        disabled={false}
        history={[]}
      />
    )
  }

  const instance = render(<Harness />, {
    stdin,
    stdout,
    stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: false,
  })
  const ready = tick()

  return {
    async input(value: string) {
      await ready
      stdin.write(value)
      await tick()
    },
    cleanup() {
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    },
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
}
