import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadAttachment } from '../src/core/attachments'
import { compactCutIndex, compactHistory, shouldAutoCompact } from '../src/core/compact'
import { checkForUpdates } from '../src/core/update'
import { configSchema } from '../src/config/schema'
import { formatRateLimits, parseRateLimits } from '../src/providers/rate-limits'
import type { Message, Provider, StreamEvent } from '../src/providers/types'

const scratch = await mkdtemp(path.join(tmpdir(), 'kitcode-features-'))

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('attachments', () => {
  it('loads quoted UTF-8 paths and supported image data', async () => {
    const textPath = path.join(scratch, 'notes with spaces.md')
    await writeFile(textPath, '# Notes\nhello', 'utf8')
    const text = await loadAttachment(scratch, `"${textPath}"`)
    expect(text.block).toMatchObject({
      type: 'file',
      mediaType: 'text/markdown',
      name: 'notes with spaces.md',
      text: '# Notes\nhello',
    })
    expect((await loadAttachment(scratch, textPath.replace(/ /g, '\\ '))).block).toMatchObject({
      type: 'file',
      name: 'notes with spaces.md',
    })

    const pngPath = path.join(scratch, 'screen.bin')
    await writeFile(
      pngPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    )
    const image = await loadAttachment(scratch, pngPath)
    expect(image.block).toMatchObject({ type: 'image', mediaType: 'image/png' })
  })

  it('rejects binary files that are not supported images', async () => {
    const file = path.join(scratch, 'payload.bin')
    await writeFile(file, Buffer.from([1, 0, 2, 3]))
    await expect(loadAttachment(scratch, file)).rejects.toThrow(/Unsupported binary/)
  })
})

describe('provider rate limits', () => {
  it('parses OpenAI-compatible and Anthropic header families without guessing', () => {
    const openAi = parseRateLimits(
      new Headers({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '42',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-limit-tokens': '100000',
        'x-ratelimit-remaining-tokens': '75000',
      }),
    )
    expect(openAi).toEqual({
      requests: { limit: 60, remaining: 42, reset: '1s' },
      tokens: { limit: 100_000, remaining: 75_000 },
    })
    expect(formatRateLimits(openAi!)).toEqual([
      'requests  42 / 60 left · reset 1s',
      'tokens  75,000 / 100,000 left',
    ])

    expect(
      parseRateLimits(
        new Headers({
          'anthropic-ratelimit-input-tokens-limit': '2000',
          'anthropic-ratelimit-input-tokens-remaining': '1500',
        }),
      ),
    ).toEqual({ inputTokens: { limit: 2000, remaining: 1500 } })
    expect(parseRateLimits(new Headers({ 'content-type': 'application/json' }))).toBeNull()
  })
})

describe('context compaction', () => {
  const history: Message[] = Array.from({ length: 4 }, (_, index) => [
    { role: 'user', content: [{ type: 'text', text: `question ${index}` }] } as Message,
    { role: 'assistant', content: [{ type: 'text', text: `answer ${index}` }] } as Message,
  ]).flat()

  it('keeps the latest three user turns and replaces older messages with a durable summary', async () => {
    expect(compactCutIndex(history)).toBe(2)
    const provider: Provider = {
      id: 'test',
      kind: 'openai',
      knownModels: () => [],
      listModels: async () => [],
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'Earlier requirement: keep tests green.' }
        yield {
          type: 'usage',
          usage: { input: 100, output: 20, cacheWrite: 0, cacheRead: 0 },
        }
        yield { type: 'rate_limits', limits: { requests: { remaining: 9, limit: 10 } } }
        yield {
          type: 'done',
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Earlier requirement: keep tests green.' }],
        }
      },
    }
    const result = await compactHistory({
      provider,
      model: 'model',
      history,
      maxTokens: 64_000,
      signal: new AbortController().signal,
    })
    expect(result.compacted).toBe(true)
    expect(result.removedMessages).toBe(2)
    expect(result.history[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('keep tests green'),
    })
    expect(result.history.slice(2)).toEqual(history.slice(2))
    expect(result.rateLimits).toEqual({ requests: { remaining: 9, limit: 10 } })
  })

  it('starts automatic compaction at 80 percent only when the window is known', () => {
    expect(shouldAutoCompact(79_999, 100_000)).toBe(false)
    expect(shouldAutoCompact(80_000, 100_000)).toBe(true)
    expect(shouldAutoCompact(999_999, null)).toBe(false)
  })
})

describe('update checking', () => {
  it('is disabled by default while the repository is private', () => {
    expect(configSchema.parse({}).updates).toEqual({ checkOnStart: false })
  })

  it('compares an embedded commit with GitHub only when explicitly invoked', async () => {
    const current = 'a'.repeat(40)
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ sha: 'b'.repeat(40), html_url: 'https://github.com/example' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(checkForUpdates(fetcher as typeof fetch, current)).resolves.toMatchObject({
      status: 'available',
      current,
      latest: 'b'.repeat(40),
    })
    expect(fetcher).toHaveBeenCalledOnce()

    fetcher.mockClear()
    await expect(checkForUpdates(fetcher as typeof fetch, 'development')).resolves.toMatchObject({
      status: 'unknown',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
