import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnthropicProvider } from '../src/providers/anthropic'
import { createOpenAiProvider } from '../src/providers/openai-compat'
import { KITCODE_VERSION } from '../src/version'

const servers: http.Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function recordUserAgent(): Promise<{ baseUrl: string; seen: string[] }> {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers['user-agent']))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [], has_more: false }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

describe('User-Agent sent to providers', () => {
  it('puts KitCode in front of the SDK token', async () => {
    const openai = await recordUserAgent()
    await createOpenAiProvider({ id: 'o', apiKey: 'k', baseUrl: `${openai.baseUrl}/v1` }).listModels()
    expect(openai.seen[0]?.startsWith(`KitCode/${KITCODE_VERSION} OpenAI/JS `)).toBe(true)

    const anthropic = await recordUserAgent()
    await createAnthropicProvider({ id: 'a', apiKey: 'k', baseUrl: anthropic.baseUrl }).listModels()
    expect(anthropic.seen[0]?.startsWith(`KitCode/${KITCODE_VERSION} Anthropic/JS `)).toBe(true)
  })

  it('lets a User-Agent from the provider config win, in any letter case', async () => {
    const openai = await recordUserAgent()
    await createOpenAiProvider({ id: 'o', apiKey: 'k', baseUrl: `${openai.baseUrl}/v1`, headers: { 'user-agent': 'custom/1' } }).listModels()
    expect(openai.seen[0]).toBe('custom/1')
  })
})
