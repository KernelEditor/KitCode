import { addUsage, emptyUsage } from '../providers/types'
import type { Usage } from '../providers/types'
import type { ModelPricing } from '../providers/types'
import { costOf, pricingFor } from '../providers/pricing'
import type { UsageEntry } from './types'

export interface UsageTotals {
  usage: Usage
  costUsd: number | null
  requests: number
}

export interface UsageTracker {
  record(modelRef: string, usage: Usage): void
  restore(entries: UsageSeed[]): void
  entries(): UsageEntry[]
  totals(): UsageTotals
  reset(): void
}

type UsageSeed = Pick<UsageEntry, 'model' | 'usage' | 'requests'>

export type PricingResolver = (modelRef: string) => ModelPricing | undefined

export function createUsageTracker(
  initial: UsageSeed[] = [],
  resolvePricing: PricingResolver = pricingFor,
): UsageTracker {
  const byModel = new Map<string, { usage: Usage; requests: number }>(
    initial.map((entry) => [entry.model, { usage: entry.usage, requests: entry.requests }]),
  )

  const entries = (): UsageEntry[] =>
    [...byModel].map(([model, { usage, requests }]) => ({
      model,
      usage,
      requests,
      costUsd: costOf(usage, resolvePricing(model)),
    }))

  return {
    record(modelRef, usage) {
      const current = byModel.get(modelRef)
      byModel.set(modelRef, {
        usage: addUsage(current?.usage ?? emptyUsage(), usage),
        requests: (current?.requests ?? 0) + 1,
      })
    },
    restore(initial) {
      byModel.clear()
      for (const entry of initial) {
        byModel.set(entry.model, { usage: entry.usage, requests: entry.requests })
      }
    },
    entries,
    totals() {
      let usage = emptyUsage()
      let requests = 0
      let cost: number | null = null
      for (const entry of entries()) {
        usage = addUsage(usage, entry.usage)
        requests += entry.requests
        if (entry.costUsd !== null) cost = (cost ?? 0) + entry.costUsd
      }
      return { usage, costUsd: cost, requests }
    },
    reset() {
      byModel.clear()
    },
  }
}

export interface UsageSummary {
  input: string
  output: string
  cache: string | null
  costUsd: number | null
  /** Combined tokens consumed so far (input + output + cache). */
  totalTokens: number
}

export function usageParts(tracker: UsageTracker): UsageSummary {
  const { usage, costUsd } = tracker.totals()
  const cache = usage.cacheRead + usage.cacheWrite
  return {
    input: tokens(usage.input),
    output: tokens(usage.output),
    cache: cache > 0 ? tokens(cache) : null,
    costUsd,
    totalTokens: usage.input + usage.output + cache,
  }
}

/** Tokens occupying the context window for one provider request. */
export function contextTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheWrite + usage.cacheRead
}

export function formatUsageCompact(tracker: UsageTracker): string {
  const { usage, costUsd } = tracker.totals()
  const cache = usage.cacheRead + usage.cacheWrite
  const parts = [`${tokens(usage.input)}↑`, `${tokens(usage.output)}↓`]
  if (cache > 0) parts.push(`(${tokens(cache)} cache)`)
  const head = parts.join(' ')
  return costUsd === null ? head : `${head} · ${dollars(costUsd)}`
}

export function formatUsageBreakdown(tracker: UsageTracker): string {
  const entries = tracker.entries()
  if (entries.length === 0) return 'No usage recorded yet.'

  const lines: string[] = []
  for (const entry of entries) {
    lines.push(`${entry.model}  ${entry.requests} ${entry.requests === 1 ? 'request' : 'requests'}`)
    lines.push(`  input        ${tokens(entry.usage.input)}`)
    lines.push(`  output       ${tokens(entry.usage.output)}`)
    lines.push(`  cache write  ${tokens(entry.usage.cacheWrite)}`)
    lines.push(`  cache read   ${tokens(entry.usage.cacheRead)}`)
    lines.push(`  cost         ${entry.costUsd === null ? 'unknown pricing' : dollars(entry.costUsd)}`)
  }
  lines.push('', `total  ${formatUsageCompact(tracker)}`)
  return lines.join('\n')
}

function tokens(count: number): string {
  if (count < 1000) return String(count)
  const [value, suffix] = count < 1_000_000 ? [count / 1000, 'k'] : [count / 1_000_000, 'M']
  return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`
}

export function dollars(amount: number): string {
  return amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`
}
