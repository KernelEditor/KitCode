import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release workflow', () => {
  it('uses npm trusted publishing instead of a 2FA-bound long-lived token', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8')

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('npm@11.5.1')
    expect(workflow).toContain('Publish to npm with OIDC')
    expect(workflow).not.toContain('secrets.NPM_TOKEN')
  })

  it('does not run a second publish against a mismatched GitHub Packages scope', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8')
    expect(workflow).not.toContain('publish-github:')
    expect(workflow).not.toContain('npm.pkg.github.com')
  })
})
