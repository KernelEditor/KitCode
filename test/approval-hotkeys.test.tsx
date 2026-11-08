import { PassThrough } from 'node:stream'
import type { ReactNode } from 'react'
import { render } from 'ink'
import { expect, it, vi } from 'vitest'
import { Confirm } from '../src/ui/components/Confirm'
import { PermissionPrompt } from '../src/ui/components/PermissionPrompt'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 60))
async function withInput(node: ReactNode, body: (stdin: PassThrough) => Promise<void>) {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 })
  const app = render(node, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
  try { await tick(); await body(stdin) }
  finally { app.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy() }
}

it('does not grant tool permissions from Ctrl+A or Ctrl+Y', async () => {
  const onDecide = vi.fn()
  await withInput(<PermissionPrompt request={{ toolName: 'write', summary: 'write file', input: {} }} onDecide={onDecide} />, async (stdin) => {
    stdin.write('\x01')
    stdin.write('\x19')
    await tick()
    expect(onDecide).not.toHaveBeenCalled()
    stdin.write('y')
    await tick()
    expect(onDecide).toHaveBeenCalledWith('once')
  })
})

it('does not approve a destructive confirmation from Ctrl+Y', async () => {
  const onAnswer = vi.fn()
  await withInput(<Confirm title="Delete sessions?" danger onAnswer={onAnswer} />, async (stdin) => {
    stdin.write('\x19')
    await tick()
    expect(onAnswer).not.toHaveBeenCalled()
    stdin.write('y')
    await tick()
    expect(onAnswer).toHaveBeenCalledWith(true)
  })
})
