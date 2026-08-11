import { existsSync } from 'node:fs'
import { formatModelRef, parseModelRef } from '../config/schema'
import { detectProvider } from '../config/detect'
import { authPath, projectConfigPath } from '../config/paths'
import {
  configLocation,
  initProjectConfig,
  loadAuth,
  loadConfig,
  loadGlobalConfig,
  loadProjectConfig,
  saveAuth,
  saveConfig,
} from '../config/store'
import { isWorkspaceTrusted, trustWorkspace } from '../config/trust'
import type { ModelInfo } from '../providers/types'

const PREFERRED = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5', 'claude-opus-4-8']
const LABEL_WIDTH = 10
const ALTERNATIVES = 2

export async function addProvider(
  url: string,
  key: string,
  options: { name?: string; local?: boolean } = {},
): Promise<void> {
  const cwd = process.cwd()
  if (options.local) {
    const existing = projectConfigPath(cwd)
    if (existsSync(existing) && !(await isWorkspaceTrusted(cwd))) {
      throw new Error(
        `Project config already exists at ${existing}. Review it and run "kitcode trust" before adding a provider to it.`,
      )
    }
  }
  const detected = await detectProvider(url, key, { name: options.name })
  if (options.local) {
    await initProjectConfig(cwd)
    await trustWorkspace(cwd)
  }
  const config = options.local
    ? await loadProjectConfig(cwd)
    : process.env.KITCODE_CONFIG
      ? await loadConfig(cwd)
      : await loadGlobalConfig()
  const auth = await loadAuth()
  const configBefore = structuredClone(config)
  const authBefore = { ...auth }

  config.providers[detected.id] = detected.config
  auth[detected.id] = key

  const models = detected.models
  if (!config.model) {
    const chosen = pickDefault(models)
    if (chosen) config.model = formatModelRef(detected.id, chosen)
  }

  try {
    await saveConfig(config)
    await saveAuth(auth)
  } catch (error) {
    Object.assign(config, configBefore)
    for (const id of Object.keys(auth)) delete auth[id]
    Object.assign(auth, authBefore)
    await Promise.allSettled([saveConfig(config), saveAuth(auth)])
    throw error
  }
  const location = await configLocation()

  const protocol = detected.config.type === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'
  const rows: [string, string][] = [
    ['provider', `${detected.id} — this endpoint speaks the ${protocol} protocol`],
    ['models', models.length === 0 ? 'none listed by this endpoint' : `${models.length} available`],
    ['default', describeDefault(config.model, detected.id, models)],
  ]

  alternatives(models, config.model, detected.id).forEach((model, index) => {
    const ref = formatModelRef(detected.id, model.id)
    rows.push([index === 0 ? 'also try' : '', `${ref}  ${price(model)}`])
  })

  rows.push(['config', `${location.path} (${location.scope})`])
  rows.push(['key', `${authPath} — mode 0600, never written into a project directory`])
  rows.push(['next', 'run kitcode to start a session; /model switches models'])

  for (const [label, value] of rows) console.log(label.padEnd(LABEL_WIDTH) + value)
}

function describeDefault(ref: string | undefined, providerId: string, models: ModelInfo[]): string {
  if (!ref) return 'not set — start kitcode and pick one with /model'
  const parsed = parseModelRef(ref)
  if (parsed?.provider !== providerId) return `${ref} — already in your config, left alone`
  return `${ref}  ${price(models.find((model) => model.id === parsed.model))}`
}

function price(model: ModelInfo | undefined): string {
  const pricing = model?.pricing
  if (!pricing) return 'pricing not reported by this endpoint'
  return `${money(pricing.input)} in / ${money(pricing.output)} out per million tokens`
}

function money(value: number): string {
  return `$${value >= 1 ? value.toFixed(2) : Number(value.toFixed(4))}`
}

function pickDefault(models: ModelInfo[]): string | undefined {
  for (const preferred of PREFERRED) {
    const match = models.find((model) => model.id.endsWith(preferred))
    if (match) return match.id
  }
  return models[0]?.id
}

function alternatives(
  models: ModelInfo[],
  defaultRef: string | undefined,
  providerId: string,
): ModelInfo[] {
  const ranked = [
    ...PREFERRED.flatMap((preferred) => models.filter((model) => model.id.endsWith(preferred))),
    ...models.filter((model) => model.pricing),
    ...models,
  ]
  const picked = new Map<string, ModelInfo>()
  for (const model of ranked) {
    if (picked.size === ALTERNATIVES) break
    if (formatModelRef(providerId, model.id) !== defaultRef) picked.set(model.id, model)
  }
  return [...picked.values()]
}
