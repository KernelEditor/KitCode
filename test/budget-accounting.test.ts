import { describe, expect, it, vi } from 'vitest'
import { budgetSchema, configSchema } from '../src/config/schema'
import { createTurnBudget } from '../src/core/budget'
import { createUsageTracker } from '../src/core/usage'

const sdk = vi.hoisted(() => ({ models: [] as unknown[] }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    models = { list: async function* () { yield* sdk.models } }
  },
}))
import { createAnthropicProvider } from '../src/providers/anthropic'

const request = { modelRef: 'gateway/claude-fable-5', estimatedInputTokens: 600_000, maxOutputTokens: 64_000 }

describe('independent opt-in cost budgets', () => {
  it('defaults to no hidden dollar ceiling, including partial persisted config', () => {
    expect(configSchema.parse({}).budget.maxCostUsdPerTurn).toBe(0)
    expect(configSchema.parse({ budget: { maxTokensPerTurn: 0 } }).budget.maxCostUsdPerTurn).toBe(0)
    expect(budgetSchema.parse({ maxCostUsdPerTurn: 0 }).maxCostUsdPerTurn).toBe(0)
    expect(budgetSchema.safeParse({ maxCostUsdPerTurn: -1 }).success).toBe(false)
  })

  it.each([0, 10_000_000])('allows large Fable requests with token limit %s and disabled cost cap', (maxTokensPerTurn) => {
    const budget = createTurnBudget({ maxTokensPerTurn, maxCostUsdPerTurn: 0 })
    expect(budget.beforeRequest(request)).toEqual({ allowed: true, maxOutputTokens: 64_000 })
    budget.record(request.modelRef, { input: 600_000, output: 64_000, cacheRead: 0, cacheWrite: 0 })
    expect(budget.snapshot().costUsd).toBeCloseTo(9.2)
    expect(budget.beforeRequest(request).allowed).toBe(true)
  })

  it('preserves explicitly configured dollar ceilings and enforces them independently', () => {
    const limits = budgetSchema.parse({ maxTokensPerTurn: 0, maxCostUsdPerTurn: 5 })
    expect(createTurnBudget(limits).beforeRequest(request)).toMatchObject({ allowed: false, reason: expect.stringContaining('cost budget ($5.00)') })
    const restored = configSchema.parse(JSON.parse(JSON.stringify({ budget: limits })))
    expect(restored.budget.maxCostUsdPerTurn).toBe(5)
  })

  it('still enforces token ceilings when cost is disabled', () => {
    expect(createTurnBudget({ maxTokensPerTurn: 1000, maxCostUsdPerTurn: 0 }).beforeRequest(request))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('token budget') })
  })
})

describe('Anthropic-compatible gateway accounting', () => {
  it('prefers gateway Fable prices over built-in estimates, including cache rates', async () => {
    sdk.models = [{ id: 'claude-fable-5', display_name: 'Fable', pricing: {
      prompt: '0.00002', completion: '0.0001', input_cache_write: '0.000025', input_cache_read: '0.000002',
    } }]
    const provider = createAnthropicProvider({ id: 'gateway', apiKey: 'test' })
    const [model] = await provider.listModels()
    expect(model?.pricing).toEqual({ input: 20, output: 100, cacheWrite: 25, cacheRead: 2 })
    const tracker = createUsageTracker([], () => model?.pricing)
    tracker.record(request.modelRef, { input: 1_000_000, output: 100_000, cacheWrite: 100_000, cacheRead: 1_000_000 })
    expect(tracker.totals().costUsd).toBe(34.5)
    const budget = createTurnBudget({ maxTokensPerTurn: 0, maxCostUsdPerTurn: 10 }, () => model?.pricing)
    expect(budget.beforeRequest(request).allowed).toBe(false)
  })

  it('retains known-price estimates if an endpoint omits pricing', async () => {
    sdk.models = [{ id: 'claude-fable-5', display_name: 'Fable' }]
    const [model] = await createAnthropicProvider({ id: 'gateway', apiKey: 'test' }).listModels()
    expect(model?.pricing).toEqual({ input: 10, output: 50 })
  })
})
