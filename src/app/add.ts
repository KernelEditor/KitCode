import { existsSync } from 'node:fs'
import { formatModelRef, parseModelRef } from '../config/schema'
import { detectProvider } from '../config/detect'
import type { DetectedProvider } from '../config/detect'
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

  for (const provider of detected) {
    config.providers[provider.id] = provider.config
    auth[provider.id] = key
  }

  const primary = detected[0]!
  const models = detected.flatMap((provider) => provider.models)
  if (!config.model) {
    const chosen = pickDefaultRef(detected)
    if (chosen) config.model = chosen
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

  const rows: [string, string][] = detected.map((provider) => [
    'provider',
    `${provider.id} — this endpoint speaks the ${protocolLabel(provider)} protocol`,
  ])
  rows.push(
    ['models', models.length === 0 ? 'none listed by this endpoint' : `${models.length} available`],
    ['default', describeDefault(config.model, detected)],
  )

  alternatives(detected, config.model).forEach(([ref, model], index) => {
    rows.push([index === 0 ? 'also try' : '', `${ref}  ${price(model)}`])
  })

  rows.push(['config', `${location.path} (${location.scope})`])
  rows.push(['key', `${authPath} — mode 0600, never written into a project directory`])
  rows.push(['next', 'run kitcode to start a session; /model switches models'])

  for (const [label, value] of rows) console.log(label.padEnd(LABEL_WIDTH) + value)
}

function protocolLabel(provider: DetectedProvider): string {
  return provider.config.type === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'
}

function describeDefault(ref: string | undefined, detected: DetectedProvider[]): string {
  if (!ref) return 'not set — start kitcode and pick one with /model'
  const parsed = parseModelRef(ref)
  const owner = detected.find((provider) => provider.id === parsed?.provider)
  if (!owner) return `${ref} — already in your config, left alone`
  return `${ref}  ${price(owner.models.find((model) => model.id === parsed!.model))}`
}

function price(model: ModelInfo | undefined): string {
  const pricing = model?.pricing
  if (!pricing) return 'pricing not reported by this endpoint'
  return `${money(pricing.input)} in / ${money(pricing.output)} out per million tokens`
}

function money(value: number): string {
  return `$${value >= 1 ? value.toFixed(2) : Number(value.toFixed(4))}`
}

function pickDefaultRef(detected: DetectedProvider[]): string | undefined {
  const refs = modelRefs(detected)
  for (const preferred of PREFERRED) {
    const match = refs.find(([, model]) => model.id.endsWith(preferred))
    if (match) return match[0]
  }
  return refs[0]?.[0]
}

function alternatives(
  detected: DetectedProvider[],
  defaultRef: string | undefined,
): [string, ModelInfo][] {
  const refs = modelRefs(detected)
  const ranked = [
    ...PREFERRED.flatMap((preferred) => refs.filter(([, model]) => model.id.endsWith(preferred))),
    ...refs.filter(([, model]) => model.pricing),
    ...refs,
  ]
  const picked = new Map<string, ModelInfo>()
  for (const [ref, model] of ranked) {
    if (picked.size === ALTERNATIVES) break
    if (ref !== defaultRef) picked.set(ref, model)
  }
  return [...picked.entries()]
}

function modelRefs(detected: DetectedProvider[]): [string, ModelInfo][] {
  return detected.flatMap((provider) =>
    provider.models.map((model): [string, ModelInfo] => [
      formatModelRef(provider.id, model.id),
      model,
    ]),
  )
}
