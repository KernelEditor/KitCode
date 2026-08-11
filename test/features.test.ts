import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  loadAttachment,
  loadAutomaticAttachment,
  loadClipboardImage,
  looksLikeAttachmentPath,
} from '../src/core/attachments'
import { compactCutIndex, compactHistory, shouldAutoCompact } from '../src/core/compact'
import { checkForUpdates } from '../src/core/update'
import { configSchema } from '../src/config/schema'
import { formatRateLimits, parseRateLimits } from '../src/providers/rate-limits'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/providers/types'

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

  it('recognizes pasted paths only when they resolve to a real file', async () => {
    const file = path.join(scratch, 'dragged notes.txt')
    await writeFile(file, 'from drag and drop', 'utf8')

    expect(looksLikeAttachmentPath(file)).toBe(true)
    expect(looksLikeAttachmentPath('ordinary message without a path')).toBe(false)
    await expect(loadAutomaticAttachment(scratch, 'missing.txt')).resolves.toBeNull()
    await expect(loadAutomaticAttachment(scratch, 'ordinary message')).resolves.toBeNull()
    await expect(loadAutomaticAttachment(scratch, pathToFileURL(file).href)).resolves.toMatchObject({
      block: { type: 'file', name: 'dragged notes.txt', text: 'from drag and drop' },
    })
  })

  it('requires an explicit command for sensitive-looking files', async () => {
    const file = path.join(scratch, '.env')
    await writeFile(file, 'API_KEY=secret', 'utf8')

    await expect(loadAutomaticAttachment(scratch, file)).rejects.toThrow(/explicitly with \/attach/)
    await expect(loadAttachment(scratch, file)).resolves.toMatchObject({
      block: { type: 'file', name: '.env' },
    })
  })

  it('never auto-attaches a pasted path outside the workspace', async () => {
    const externalDir = await mkdtemp(path.join(tmpdir(), 'kitcode-feature-external-'))
    try {
      const file = path.join(externalDir, 'innocent-looking.txt')
      await writeFile(file, 'private outside-workspace text', 'utf8')
      await expect(loadAutomaticAttachment(scratch, file)).resolves.toBeNull()
      await expect(loadAttachment(scratch, file)).resolves.toMatchObject({
        block: { type: 'file', text: 'private outside-workspace text' },
      })
    } finally {
      await rm(externalDir, { recursive: true, force: true })
    }
  })

  it('converts an image returned by the platform clipboard reader', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const runner = vi.fn(async (_command: string, _args: string[]) => png)

    await expect(loadClipboardImage('darwin', runner)).resolves.toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      name: 'clipboard.png',
    })
    expect(runner).toHaveBeenCalledWith('osascript', expect.arrayContaining(['-l', 'JavaScript']))
    const script = runner.mock.calls[0]?.[1].at(-1)
    expect(script).toContain('ObjC.unwrap(value) !== undefined')
    expect(script).toContain('NSPasteboardTypeFileURL')
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

  it('keeps the latest two user turns and replaces older messages with a durable summary', async () => {
    expect(compactCutIndex(history)).toBe(4)
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
    expect(result.removedMessages).toBe(4)
    expect(result.history[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('keep tests green'),
    })
    expect(result.history.slice(2)).toEqual(history.slice(4))
    expect(result.rateLimits).toEqual({ requests: { remaining: 9, limit: 10 } })
  })

  it('starts automatic compaction at 80 percent only when the window is known', () => {
    expect(shouldAutoCompact(79_999, 100_000)).toBe(false)
    expect(shouldAutoCompact(80_000, 100_000)).toBe(true)
    expect(shouldAutoCompact(999_999, null)).toBe(false)
  })

  it('chunks the rendered payload accurately and fills a worker pool without exceeding maxTokens', async () => {
    const largeHistory: Message[] = Array.from({ length: 72 }, (_, index) => [
      { role: 'user', content: [{ type: 'text', text: `question ${index}` }] } as Message,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            toolUseId: `tool-${index}`,
            content: `result ${index} ${'x'.repeat(100_000)}`,
          },
        ],
      } as Message,
    ]).flat()
    const summarySources: string[] = []
    const requestedMaxTokens: number[] = []
    let active = 0
    let maxActive = 0
    let calls = 0
    const provider: Provider = {
      id: 'test',
      kind: 'openai',
      knownModels: () => [],
      listModels: async () => [],
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        requestedMaxTokens.push(request.maxTokens)
        if (request.system.startsWith('You are summarizing')) {
          const block = request.messages[0]?.content[0]
          summarySources.push(block?.type === 'text' ? block.text : '')
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active -= 1
        }
        const text = `summary-${++calls}`
        yield { type: 'done', stopReason: 'end_turn', content: [{ type: 'text', text }] }
      },
    }

    const result = await compactHistory({
      provider,
      model: 'model',
      history: largeHistory,
      maxTokens: 32,
      maxTotalOutputTokens: 10,
      signal: new AbortController().signal,
    })

    expect(result.compacted).toBe(true)
    expect(summarySources.length).toBeGreaterThanOrEqual(3)
    expect(summarySources.length).toBeLessThan(10)
    expect(summarySources.every((source) => source.length <= 35_000)).toBe(true)
    expect(maxActive).toBe(3)
    expect(requestedMaxTokens.every((tokens) => tokens <= 2)).toBe(true)
  })
})

describe('update checking', () => {
  it('cannot be disabled by a stale config flag', () => {
    expect(configSchema.parse({ updates: { checkOnStart: false } })).not.toHaveProperty('updates')
  })

  it('compares the installed semver with the latest npm package', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ version: '1.3.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(checkForUpdates(fetcher as typeof fetch, '1.2.3')).resolves.toEqual({
      status: 'available',
      current: '1.2.3',
      latest: '1.3.0',
      url: 'https://www.npmjs.com/package/@kernelonpanic/kitcode/v/1.3.0',
    })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toContain('registry.npmjs.org')
  })

  it('handles current, prerelease, and malformed npm versions', async () => {
    const response = (version: string) =>
      vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 }))

    await expect(checkForUpdates(response('1.2.3') as typeof fetch, '1.2.3')).resolves.toEqual({
      status: 'current',
      current: '1.2.3',
      latest: '1.2.3',
    })
    await expect(checkForUpdates(response('1.2.3') as typeof fetch, '1.2.3-beta.1')).resolves.toMatchObject({
      status: 'available',
    })
    await expect(checkForUpdates(response('latest') as typeof fetch, '1.2.3')).resolves.toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('valid version'),
    })
  })
})
