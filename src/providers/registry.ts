import { parseModelRef } from '../config/schema'
import type { AuthFile, Config, ProviderConfig } from '../config/schema'
import { resolveApiKey } from '../config/store'
import { createAnthropicProvider } from './anthropic'
import { createOpenAiProvider } from './openai-compat'
import type { Provider } from './types'

export interface ResolvedModel {
  provider: Provider
  modelId: string
}

export interface ProviderRegistry {
  get(id: string): Provider
  resolve(ref: string): ResolvedModel
}

export function createRegistry(config: Config, auth: AuthFile): ProviderRegistry {
  const built = new Map<string, Provider>()

  function get(id: string): Provider {
    const cached = built.get(id)
    if (cached) return cached

    const entry = config.providers[id]
    if (!entry) throw new Error(unknownProviderMessage(id, Object.keys(config.providers)))

    const provider = build(id, entry, apiKey(id, entry, auth))
    built.set(id, provider)
    return provider
  }

  return {
    get,
    resolve(ref) {
      const parsed = parseModelRef(ref)
      if (!parsed) {
        throw new Error(
          `Model "${ref}" is not a "<provider>/<model>" reference, e.g. "anthropic/claude-opus-5".`,
        )
      }
      return { provider: get(parsed.provider), modelId: parsed.model }
    },
  }
}

function build(id: string, entry: ProviderConfig, key: string): Provider {
  const args = { id, apiKey: key, baseUrl: entry.baseUrl, headers: entry.headers }
  return entry.type === 'anthropic' ? createAnthropicProvider(args) : createOpenAiProvider(args)
}

function apiKey(id: string, entry: ProviderConfig, auth: AuthFile): string {
  const key = resolveApiKey(id, entry, auth)
  if (key) return key
  throw new Error(
    `No API key for provider "${id}"${entry.keyEnv ? ` (env ${entry.keyEnv} is unset)` : ''}. ` +
      `Add one with: kitcode add ${entry.baseUrl}`,
  )
}

function unknownProviderMessage(id: string, known: string[]): string {
  const configured = known.length > 0 ? known.join(', ') : 'none'
  return (
    `Unknown provider "${id}". Configured providers: ${configured}. ` +
    `Add it with: kitcode add <url>`
  )
}
