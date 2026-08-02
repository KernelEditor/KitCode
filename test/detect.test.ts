import { describe, expect, it } from 'vitest'
import { detectProvider, parseModelList, providerIdFromUrl } from '../src/config/detect'

const modelBody = {
  data: [
    { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } },
    { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
    { id: 'no-price/model' },
    { nope: true },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('providerIdFromUrl', () => {
  it.each([
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.anthropic.com', 'anthropic'],
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['http://127.0.0.1:11434/v1', 'local-11434'],
    ['http://localhost:1234/v1', 'local-1234'],
  ])('%s -> %s', (url, expected) => {
    expect(providerIdFromUrl(url)).toBe(expected)
  })
})

describe('parseModelList', () => {
  it('converts per-token price strings to USD per million', () => {
    const [first] = parseModelList(modelBody)
    expect(first?.id).toBe('anthropic/claude-opus-5')
    expect(first?.pricing).toEqual({ input: 5, output: 25 })
  })

  it('omits pricing when it is zero, absent or unparseable', () => {
    const models = parseModelList(modelBody)
    expect(models.find((m) => m.id === 'free/model')?.pricing).toBeUndefined()
    expect(models.find((m) => m.id === 'no-price/model')?.pricing).toBeUndefined()
  })

  it('drops entries without an id and tolerates a non-list body', () => {
    expect(parseModelList(modelBody)).toHaveLength(3)
    expect(parseModelList({ oops: 1 })).toEqual([])
  })

  it('reads common context-window aliases from compatible APIs', () => {
    const models = parseModelList([
      { id: 'a', context_window: '131072' },
      { id: 'b', max_model_len: 262144 },
      { id: 'c', top_provider: { context_window: 1_000_000 } },
    ])
    expect(models.map((model) => model.contextWindow)).toEqual([131072, 262144, 1_000_000])
  })
})

describe('detectProvider', () => {
  it('detects an OpenAI-compatible endpoint via Bearer', async () => {
    const seen: string[] = []
    const result = await detectProvider('https://openrouter.ai/api/v1', 'sk-test', {
      fetchImpl: async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        seen.push(headers['Authorization'] ? 'bearer' : 'other')
        return jsonResponse(modelBody)
      },
    })
    expect(result.config.type).toBe('openai')
    expect(result.id).toBe('openrouter')
    expect(result.models).toHaveLength(3)
    expect(seen[0]).toBe('bearer')
  })

  it('falls back to x-api-key when Bearer is rejected', async () => {
    const result = await detectProvider('https://proxy.example.com/v1', 'sk-test', {
      fetchImpl: async (_input, init) => {
        const headers = ((init as RequestInit)?.headers ?? {}) as Record<string, string>
        return headers['x-api-key'] ? jsonResponse(modelBody) : jsonResponse({ error: 'no' }, 401)
      },
    })
    expect(result.config.type).toBe('anthropic')
  })

  it('appends /v1 when the bare path 404s', async () => {
    const tried: string[] = []
    const result = await detectProvider('https://api.example.com', 'sk-test', {
      fetchImpl: async (input) => {
        const url = String(input)
        tried.push(url)
        return url.includes('/v1/models') ? jsonResponse(modelBody) : jsonResponse({}, 404)
      },
    })
    expect(result.config.baseUrl).toBe('https://api.example.com/v1')
    expect(tried).toEqual(['https://api.example.com/models', 'https://api.example.com/v1/models'])
  })

  it('reports the status and body when nothing matches', async () => {
    await expect(
      detectProvider('https://api.example.com/v1', 'sk-test', {
        fetchImpl: async () => new Response('upstream exploded', { status: 500 }),
      }),
    ).rejects.toThrow(/HTTP 500.*upstream exploded/s)
  })
})
