import type { ModelPricing, Usage } from './types'

const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
}

export function pricingFor(model: string): ModelPricing | undefined {
  const direct = PRICING[model]
  if (direct) return direct
  const slash = model.lastIndexOf('/')
  return slash === -1 ? undefined : PRICING[model.slice(slash + 1)]
}

export function costOf(usage: Usage, pricing?: ModelPricing): number | null {
  if (!pricing) return null
  const cacheWrite = pricing.cacheWrite ?? pricing.input * CACHE_WRITE_MULTIPLIER
  const cacheRead = pricing.cacheRead ?? pricing.input * CACHE_READ_MULTIPLIER
  const total =
    usage.input * pricing.input +
    usage.output * pricing.output +
    usage.cacheWrite * cacheWrite +
    usage.cacheRead * cacheRead
  return total / 1_000_000
}
