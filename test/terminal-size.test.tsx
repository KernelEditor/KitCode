import { PassThrough } from 'node:stream'
import { Box, Text, render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { useTerminalSize } from '../src/ui/terminal-size'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

describe('shared terminal resize subscription', () => {
  it('shares one listener, updates every consumer, and cleans up on unmount', async () => {
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    const stderr = new PassThrough() as PassThrough & NodeJS.WriteStream
    Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: () => stdin, unref: () => stdin })
    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 })
    const sizes = new Map<number, number>()
    function Consumer({ id }: { id: number }) {
      const { columns } = useTerminalSize()
      sizes.set(id, columns)
      return <Text>{columns}</Text>
    }
    const instance = render(<Box />, { stdin, stdout, stderr, interactive: false, patchConsole: false, exitOnCtrlC: false })
    try {
      await tick()
      const baseline = stdout.listenerCount('resize')
      instance.rerender(<Box>{Array.from({ length: 30 }, (_, id) => <Consumer key={id} id={id} />)}</Box>)
      await tick()
      expect(stdout.listenerCount('resize')).toBe(baseline + 1)
      stdout.columns = 100
      stdout.emit('resize')
      await tick()
      expect(sizes.size).toBe(30)
      expect([...sizes.values()].every((size) => size === 100)).toBe(true)
      instance.rerender(<Box />)
      await tick()
      expect(stdout.listenerCount('resize')).toBe(baseline)
      stdout.columns = 90
      instance.rerender(<Consumer id={0} />)
      await tick()
      expect(sizes.get(0)).toBe(90)
      expect(stdout.listenerCount('resize')).toBe(baseline + 1)
    } finally {
      instance.cleanup()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  })
})
