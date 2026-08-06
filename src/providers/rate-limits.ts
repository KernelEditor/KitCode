import type { RateLimitBucket, RateLimits } from './types'

type HeaderNames = {
  limit?: string[]
  remaining?: string[]
  reset?: string[]
}

const SCHEMES: Record<keyof RateLimits, HeaderNames> = {
  requests: {
    limit: [
      'x-ratelimit-limit-requests',
      'anthropic-ratelimit-requests-limit',
      'ratelimit-limit',
      'x-ratelimit-limit',
    ],
    remaining: [
      'x-ratelimit-remaining-requests',
      'anthropic-ratelimit-requests-remaining',
      'ratelimit-remaining',
      'x-ratelimit-remaining',
    ],
    reset: [
      'x-ratelimit-reset-requests',
      'anthropic-ratelimit-requests-reset',
      'ratelimit-reset',
      'x-ratelimit-reset',
    ],
  },
  tokens: {
    limit: ['x-ratelimit-limit-tokens', 'anthropic-ratelimit-tokens-limit'],
    remaining: ['x-ratelimit-remaining-tokens', 'anthropic-ratelimit-tokens-remaining'],
    reset: ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-tokens-reset'],
  },
  inputTokens: {
    limit: ['anthropic-ratelimit-input-tokens-limit'],
    remaining: ['anthropic-ratelimit-input-tokens-remaining'],
    reset: ['anthropic-ratelimit-input-tokens-reset'],
  },
  outputTokens: {
    limit: ['anthropic-ratelimit-output-tokens-limit'],
    remaining: ['anthropic-ratelimit-output-tokens-remaining'],
    reset: ['anthropic-ratelimit-output-tokens-reset'],
  },
}

export function parseRateLimits(headers: Headers | null): RateLimits | null {
  if (!headers) return null
  const limits: RateLimits = {}
  for (const [name, scheme] of Object.entries(SCHEMES) as Array<
    [keyof RateLimits, HeaderNames]
  >) {
    const bucket = readBucket(headers, scheme)
    if (bucket) limits[name] = bucket
  }
  return Object.keys(limits).length > 0 ? limits : null
}

function readBucket(headers: Headers, names: HeaderNames): RateLimitBucket | null {
  const limit = readNumber(headers, names.limit)
  const remaining = readNumber(headers, names.remaining)
  const reset = readReset(headers, names.reset)
  if (limit === undefined && remaining === undefined && reset === undefined) return null
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { reset }),
  }
}

function first(headers: Headers, names: string[] | undefined): string | undefined {
  for (const name of names ?? []) {
    const value = headers.get(name)?.trim()
    if (value) return value
  }
  return undefined
}

function readNumber(headers: Headers, names: string[] | undefined): number | undefined {
  const value = first(headers, names)
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e15 ? parsed : undefined
}

function readReset(headers: Headers, names: string[] | undefined): string | undefined {
  const value = first(headers, names)
  if (!value || value.length > 80 || /[\r\n\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    return undefined
  }
  return value
}

export function formatRateLimits(limits: RateLimits): string[] {
  const labels: Array<[keyof RateLimits, string]> = [
    ['requests', 'requests'],
    ['tokens', 'tokens'],
    ['inputTokens', 'input tokens'],
    ['outputTokens', 'output tokens'],
  ]
  return labels.flatMap(([key, label]) => {
    const bucket = limits[key]
    if (!bucket) return []
    const amount =
      bucket.remaining !== undefined && bucket.limit !== undefined
        ? `${formatNumber(bucket.remaining)} / ${formatNumber(bucket.limit)} left`
        : bucket.remaining !== undefined
          ? `${formatNumber(bucket.remaining)} left`
          : bucket.limit !== undefined
            ? `limit ${formatNumber(bucket.limit)}`
            : ''
    const reset = bucket.reset ? `reset ${bucket.reset}` : ''
    const details = [amount, reset].filter(Boolean).join(' · ')
    return [`${label}${details ? `  ${details}` : ''}`]
  })
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value)
}
