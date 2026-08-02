import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const home = await mkdtemp(path.join(tmpdir(), 'kitcode-logout-'))
process.env.KITCODE_HOME = home

const { authPath, configPath } = await import('../src/config/paths')
const { boot } = await import('../src/app/runtime')
const { loadSession } = await import('../src/core/session')

const server = http.createServer((req, res) => {
  const provider = req.url?.includes('/beta/') ? 'beta' : 'alpha'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      object: 'list',
      data: [{ id: `${provider}-model`, object: 'model', created: 0, owned_by: provider }],
    }),
  )
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
  delete process.env.KITCODE_HOME
})

async function seed(): Promise<void> {
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      lang: 'en',
      model: 'alpha/alpha-model',
      providers: {
        alpha: { type: 'openai', baseUrl: `${origin}/alpha/v1` },
        beta: { type: 'openai', baseUrl: `${origin}/beta/v1` },
      },
    }),
    'utf8',
  )
  await writeFile(authPath, JSON.stringify({ alpha: 'sk-alpha', beta: 'sk-beta' }), 'utf8')
}

describe('provider logout', () => {
  it('starts a new session without overwriting the saved conversation', async () => {
    await seed()
    const app = await boot({ cwd: home })
    try {
      const oldId = app.runtime.sessionId()
      const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'keep me' }] }]
      await app.runtime.persist(messages)
      const newId = await app.runtime.newSession()

      expect(newId).not.toBe(oldId)
      expect((await loadSession(oldId)).messages).toEqual(messages)
    } finally {
      await app.shutdown()
    }
  })

  it('removes only the selected provider and switches only when the active one is removed', async () => {
    await seed()
    const first = await boot({ cwd: home })
    try {
      await expect(first.runtime.logout('beta')).resolves.toEqual({
        removed: 'beta',
        wasActive: false,
      })
      expect(first.runtime.currentProviderId()).toBe('alpha')
      expect(first.runtime.listProviderItems().map((item) => item.key)).toEqual(['alpha'])
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({ alpha: 'sk-alpha' })
    } finally {
      await first.shutdown()
    }

    await seed()
    const second = await boot({ cwd: home })
    try {
      await expect(second.runtime.logout('alpha')).resolves.toEqual({
        removed: 'alpha',
        wasActive: true,
        nextModel: 'beta/beta-model',
      })
      expect(second.runtime.currentProviderId()).toBe('beta')
      expect(second.runtime.listProviderItems().map((item) => item.key)).toEqual(['beta'])
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({ beta: 'sk-beta' })
    } finally {
      await second.shutdown()
    }
  })
})
