import { renderToString } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Logo } from '../src/ui/components/Logo'
import { formatWorkspacePath } from '../src/ui/workspace'

describe('workspace path in the header', () => {
  it('replaces the home directory with a tilde', () => {
    expect(
      formatWorkspacePath('/Users/me/Documents/work/KitCode', 60, '/Users/me'),
    ).toBe('~/Documents/work/KitCode')
  })

  it('shortens the beginning while keeping the project folder visible', () => {
    const formatted = formatWorkspacePath(
      '/Users/me/Documents/clients/very/deep/product/KitCode',
      28,
      '/Users/me',
    )

    expect(formatted).toBe('…/very/deep/product/KitCode')
    expect([...formatted].length).toBeLessThanOrEqual(28)
  })

  it('keeps terminal control sequences and line breaks out of the header', () => {
    expect(formatWorkspacePath('/tmp/\u001b[31mproject\nspoof', 40, '/home/me')).toBe(
      '/tmp/project spoof',
    )
  })

  it('shows the version next to the name', () => {
    const frame = renderToString(
      createElement(Logo, {
        workspace: '/workspace/Documents/clients/very/deep/product/KitCode',
      }),
      { columns: 30 },
    )

    expect(frame).toContain('kitcode')
    expect(frame).toContain('v1.1')
  })
})
