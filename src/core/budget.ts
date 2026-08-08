import { addUsage, emptyUsage } from '../providers/types'
import type { Usage } from '../providers/types'
import { costOf, pricingFor } from '../providers/pricing'
import type { PricingResolver } from './usage'

const UNKNOWN_MODEL_PRICING = { input: 3, output: 15 } as const

export interface BudgetLimits {
  maxTokensPerTurn: number
  maxCostUsdPerTurn: number
}

export interface TurnBudget {
  beforeRequest(request: {
    modelRef: string
    maxOutputTokens: number
    estimatedInputTokens: number
  }): { allowed: true; maxOutputTokens: number } | { allowed: false; reason: string }
  record(modelRef: string, usage: Usage): void
  snapshot(): { tokens: number; costUsd: number | null }
}

export function createTurnBudget(
  limits: BudgetLimits,
  resolvePricing: PricingResolver = pricingFor,
): TurnBudget {
  let usage = emptyUsage()
  let costUsd: number | null = 0

  const snapshot = () => ({
    tokens: usage.input + usage.output + usage.cacheWrite + usage.cacheRead,
    costUsd,
  })

  return {
    beforeRequest(request) {
      const current = snapshot()
      if (limits.maxTokensPerTurn > 0 && current.tokens >= limits.maxTokensPerTurn) {
        return {
          allowed: false,
          reason: `Turn stopped at the token budget (${limits.maxTokensPerTurn.toLocaleString()} tokens). This is a safety limit to prevent runaway costs. To disable it, run: /budget 0`,
        }
      }
      if (current.costUsd !== null && current.costUsd >= limits.maxCostUsdPerTurn) {
        return {
          allowed: false,
          reason: `Turn stopped at the cost budget ($${limits.maxCostUsdPerTurn.toFixed(2)}). Send another message to continue.`,
        }
      }

      const estimatedInput = finitePositive(request.estimatedInputTokens)
      const tokenLimit = limits.maxTokensPerTurn
      let outputLimit = tokenLimit === 0
        ? finitePositive(request.maxOutputTokens)
        : Math.min(
            finitePositive(request.maxOutputTokens),
            tokenLimit - current.tokens - estimatedInput,
          )
      if (outputLimit < 1) {
        return {
          allowed: false,
          reason: `Turn stopped because the next request would exceed the token budget (${limits.maxTokensPerTurn.toLocaleString()} tokens). This is a safety limit to prevent runaway costs. To disable it, run: /budget 0`,
        }
      }

      const pricing = resolvePricing(request.modelRef)
      if (current.costUsd !== null) {
        const remainingUsd = limits.maxCostUsdPerTurn - current.costUsd
        // Use fallback pricing if model pricing is unknown to prevent unlimited spending
        const effectivePricing = pricing ?? UNKNOWN_MODEL_PRICING
        const inputUsd = (estimatedInput * effectivePricing.input) / 1_000_000
        const affordableOutput = Math.floor(
          ((remainingUsd - inputUsd) * 1_000_000) / effectivePricing.output,
        )
        outputLimit = Math.min(outputLimit, affordableOutput)
        if (outputLimit < 1) {
          return {
            allowed: false,
            reason: `Turn stopped because the next request would exceed the cost budget ($${limits.maxCostUsdPerTurn.toFixed(2)}). Send another message to continue.`,
          }
        }
      }

      return { allowed: true, maxOutputTokens: Math.floor(outputLimit) }
    },
    record(modelRef, next) {
      const normalized = normalizeUsage(next)
      usage = addUsage(usage, normalized)
      const priced = costOf(normalized, resolvePricing(modelRef) ?? UNKNOWN_MODEL_PRICING)
      costUsd = (costUsd ?? 0) + (priced ?? 0)
    },
    snapshot,
  }
}

function normalizeUsage(usage: Usage): Usage {
  return {
    input: finitePositive(usage.input),
    output: finitePositive(usage.output),
    cacheWrite: finitePositive(usage.cacheWrite),
    cacheRead: finitePositive(usage.cacheRead),
  }
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}
