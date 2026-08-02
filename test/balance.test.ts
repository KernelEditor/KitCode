import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../src/config/schema'
import { fetchProviderBalance } from '../src/providers/balance'

const provider = (baseUrl: string): ProviderConfig => ({
  type: 'openai',
  baseUrl,
})

describe('provider balance discovery', () => {
  it('reads a DeepSeek balance from the documented endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '42.50' },
          { currency: 'CNY', total_balance: '300.00' },
        ],
      }),
    )

    await expect(
      fetchProviderBalance(provider('https://api.deepseek.com/v1'), 'secret', { fetchImpl }),
    ).resolves.toEqual([
      { kind: 'balance', currency: 'USD', amount: '42.50' },
      { kind: 'balance', currency: 'CNY', amount: '300.00' },
    ])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    )
  })

  it('uses the remaining limit returned for the current OpenRouter API key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: { limit: 100, limit_remaining: 74.5, usage: 25.5 } }),
    )

    await expect(
      fetchProviderBalance(provider('https://openrouter.ai/api/v1'), 'secret', { fetchImpl }),
    ).resolves.toEqual([{ kind: 'key-limit', currency: 'USD', amount: '74.5' }])
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key')
  })

  it('falls back to OpenRouter account credits when the key has no limit balance', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { limit: null, limit_remaining: null } }))
      .mockResolvedValueOnce(
        Response.json({ data: { total_credits: 100, total_usage: 12.345 } }),
      )

    await expect(
      fetchProviderBalance(provider('https://openrouter.ai/api/v1'), 'secret', { fetchImpl }),
    ).resolves.toEqual([{ kind: 'balance', currency: 'USD', amount: '87.66' }])
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/credits',
    ])
  })

  it('tries compatible balance shapes on the configured origin and stops at the first match', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: { unrelated: true } }))
      .mockResolvedValueOnce(Response.json({ data: { unrelated: true } }))
      .mockResolvedValueOnce(Response.json({ status: true, data: { balance: '77.7' } }))

    await expect(
      fetchProviderBalance(provider('https://gateway.example/v1'), 'secret', { fetchImpl }),
    ).resolves.toEqual([{ kind: 'balance', currency: 'credits', amount: '77.7' }])

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/user/balance',
      'https://gateway.example/api/v1/key',
      'https://gateway.example/api/v1/credits',
      'https://gateway.example/v1/user/info',
    ])
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer secret' }))
      expect(init?.redirect).toBe('error')
    }
  })

  it('does not probe providers whose balance API requires a different admin credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(
      fetchProviderBalance(provider('https://api.openai.com/v1'), 'secret', { fetchImpl }),
    ).resolves.toBeNull()
    await expect(
      fetchProviderBalance(provider('https://api.anthropic.com/v1'), 'secret', { fetchImpl }),
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('hides malformed or unsupported responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ balance: -5 }))

    await expect(
      fetchProviderBalance(provider('https://gateway.example/v1'), 'secret', { fetchImpl }),
    ).resolves.toBeNull()
  })

  it('does not buffer an oversized balance response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        balance_infos: [{ currency: 'USD', total_balance: '1.00' }],
        padding: 'x'.repeat(65_000),
      }),
    )

    await expect(
      fetchProviderBalance(provider('https://api.deepseek.com/v1'), 'secret', { fetchImpl }),
    ).resolves.toBeNull()
  })
})
