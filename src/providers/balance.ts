import type { ProviderConfig } from '../config/schema'
import { expandEnvRecord } from '../config/store'

export interface ProviderBalance {
  kind: 'balance' | 'key-limit'
  currency: string
  amount: string
}

const MAX_RESPONSE_BYTES = 64_000

export async function fetchProviderBalance(
  config: ProviderConfig,
  apiKey: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ProviderBalance[] | null> {
  const endpoints = balanceEndpoints(config.baseUrl)
  if (endpoints.length === 0) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    for (const endpoint of endpoints) {
      try {
        const response = await (options.fetchImpl ?? fetch)(endpoint.url, {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            ...expandEnvRecord(config.headers ?? {}),
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          continue
        }
        const text = await limitedResponseText(response, MAX_RESPONSE_BYTES)
        if (text === null) continue
        const balance = endpoint.parse(JSON.parse(text))
        if (balance?.length) return balance
      } catch {
        if (controller.signal.aborted) break
      }
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface BalanceEndpoint {
  url: string
  parse(body: unknown): ProviderBalance[] | null
}

function balanceEndpoints(baseUrl: string): BalanceEndpoint[] {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return []
  }
  const host = url.hostname.toLowerCase()
  if (host === 'api.deepseek.com') {
    return [endpoint(url.origin, '/user/balance', deepSeekBalance)]
  }
  if (host === 'openrouter.ai') {
    return [
      endpoint(url.origin, '/api/v1/key', openRouterKeyBalance),
      endpoint(url.origin, '/api/v1/credits', openRouterCreditsBalance),
    ]
  }
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') {
    return [endpoint(url.origin, '/v1/user/info', siliconFlowBalance)]
  }
  if (host === 'api.apimart.ai') {
    return [endpoint(url.origin, '/v1/user/balance', apiMartBalance)]
  }
  if (host === 'api.openai.com' || host === 'api.anthropic.com') return []

  
  
  
  return [
    endpoint(url.origin, '/user/balance', deepSeekBalance),
    endpoint(url.origin, '/api/v1/key', openRouterKeyBalance),
    endpoint(url.origin, '/api/v1/credits', openRouterCreditsBalance),
    endpoint(url.origin, '/v1/user/info', siliconFlowBalance),
    endpoint(url.origin, '/v1/user/balance', apiMartBalance),
    endpoint(url.origin, '/v1/balance', genericBalance),
  ]
}

function endpoint(
  origin: string,
  path: string,
  parse: BalanceEndpoint['parse'],
): BalanceEndpoint {
  return { url: `${origin}${path}`, parse }
}

function deepSeekBalance(body: unknown): ProviderBalance[] | null {
  const infos = record(body)?.['balance_infos']
  if (!Array.isArray(infos)) return null
  const balances = infos.flatMap((item) => {
    const entry = record(item)
    const currency = currencyCode(entry?.['currency'])
    const amount = decimal(entry?.['total_balance'])
    return currency && amount ? [{ kind: 'balance' as const, currency, amount }] : []
  })
  return balances.length > 0 ? balances : null
}

function openRouterKeyBalance(body: unknown): ProviderBalance[] | null {
  const remaining = finiteNumber(record(record(body)?.['data'])?.['limit_remaining'])
  return remaining === null
    ? null
    : [{ kind: 'key-limit', currency: 'USD', amount: String(remaining) }]
}

function openRouterCreditsBalance(body: unknown): ProviderBalance[] | null {
  const data = record(record(body)?.['data'])
  const credits = finiteNumber(data?.['total_credits'])
  const usage = finiteNumber(data?.['total_usage'])
  if (credits === null || usage === null) return null
  return [
    {
      kind: 'balance',
      currency: 'USD',
      amount: Math.max(0, credits - usage).toFixed(2),
    },
  ]
}

function siliconFlowBalance(body: unknown): ProviderBalance[] | null {
  const root = record(body)
  if (root?.['status'] !== true) return null
  const amount = decimal(record(root['data'])?.['balance'])
  return amount ? [{ kind: 'balance', currency: 'credits', amount }] : null
}

function apiMartBalance(body: unknown): ProviderBalance[] | null {
  const root = record(body)
  if (root?.['success'] !== true) return null
  const amount = decimal(root['remain_balance'])
  return amount ? [{ kind: 'balance', currency: 'credits', amount }] : null
}

function genericBalance(body: unknown): ProviderBalance[] | null {
  const root = record(body)
  const data = record(root?.['data'])
  const amount = decimal(root?.['balance'] ?? data?.['balance'])
  if (!amount) return null
  const currency = currencyCode(root?.['currency'] ?? data?.['currency']) ?? 'credits'
  return [{ kind: 'balance', currency, amount }]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function currencyCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
}

function decimal(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(value) : null
  }
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

async function limitedResponseText(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}
