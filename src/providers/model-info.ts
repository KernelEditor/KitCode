import type { ModelInfo, ModelPricing } from './types'

interface RawModel {
  id?: unknown
  name?: unknown
  display_name?: unknown
  context_length?: unknown
  context_window?: unknown
  max_context_length?: unknown
  max_model_len?: unknown
  model_max_length?: unknown
  max_sequence_length?: unknown
  max_input_tokens?: unknown
  top_provider?: { context_length?: unknown; context_window?: unknown } | null
  pricing?: unknown
}

/** Preserve metadata exposed by richer OpenAI-compatible model endpoints. */
export function modelInfoFromRaw(entry: unknown): ModelInfo | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as RawModel
  if (typeof raw.id !== 'string' || raw.id === '') return null

  const model: ModelInfo = { id: raw.id }
  const name = typeof raw.name === 'string' ? raw.name : raw.display_name
  if (typeof name === 'string' && name !== '') model.name = name

  const contextWindow =
    positiveInt(raw.context_length) ??
    positiveInt(raw.context_window) ??
    positiveInt(raw.max_context_length) ??
    positiveInt(raw.max_model_len) ??
    positiveInt(raw.model_max_length) ??
    positiveInt(raw.max_sequence_length) ??
    positiveInt(raw.top_provider?.context_length) ??
    positiveInt(raw.top_provider?.context_window) ??
    positiveInt(raw.max_input_tokens)
  if (contextWindow !== undefined) model.contextWindow = contextWindow

  const pricing = toPricing(raw.pricing)
  if (pricing) model.pricing = pricing

  return model
}

function toPricing(raw: unknown): ModelPricing | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const input = perMillion(source.prompt)
  const output = perMillion(source.completion)
  if (input === undefined || output === undefined) return undefined

  const pricing: ModelPricing = { input, output }
  const cacheWrite = perMillion(source.input_cache_write)
  const cacheRead = perMillion(source.input_cache_read)
  if (cacheWrite !== undefined) pricing.cacheWrite = cacheWrite
  if (cacheRead !== undefined) pricing.cacheRead = cacheRead
  return pricing
}

function perMillion(value: unknown): number | undefined {
  const perToken = toNumber(value)
  if (perToken === undefined || perToken <= 0) return undefined
  return Math.round(perToken * 1e12) / 1e6
}

function positiveInt(value: unknown): number | undefined {
  const parsed = toNumber(value)
  if (parsed === undefined || parsed <= 0) return undefined
  return Math.trunc(parsed)
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
