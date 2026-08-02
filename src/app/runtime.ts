import { detectProvider } from '../config/detect'
import { formatModelRef, parseModelRef } from '../config/schema'
import type { Config } from '../config/schema'
import { projectSkillsDir, skillsDir } from '../config/paths'
import { configLocation, loadAuth, loadConfig, saveAuth, saveConfig } from '../config/store'
import { runTurn } from '../core/agent'
import type { AgentConfig, ToolLookup } from '../core/agent'
import { buildSystemPrompt } from '../core/prompt'
import {
  createSession,
  latestSessionFor,
  listSessions,
  loadSession,
  resolveSessionId,
  saveSession,
  shortSessionId,
} from '../core/session'
import { createSubagentRunner } from '../core/subagent'
import type { AgentHooks, ContextUsage, SessionState } from '../core/types'
import {
  contextTokens,
  createUsageTracker,
  formatUsageBreakdown,
  formatUsageCompact,
  usageParts,
} from '../core/usage'
import { createMcpManager } from '../mcp/client'
import { loadModels } from '../providers/catalog'
import { createRegistry } from '../providers/registry'
import type { Effort, Message, ModelInfo } from '../providers/types'
import { createPermissionEngine } from '../tools/permissions'
import type { AgentMode } from '../tools/permissions'
import { builtinTools, createToolRegistry } from '../tools/registry'
import { getPrompt, listPrompts, savePrompt } from '../prompts/library'
import { discoverSkills, formatSkillCatalogue } from '../skills/library'
import { createSkillTool } from '../tools/skill'
import { createTaskTool } from '../tools/task'
import type { Lang } from '../ui/i18n'
import type { Runtime } from '../ui/runtime'
import type { PickerItem } from '../ui/types'

const PREFERRED = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5', 'claude-opus-4-8']

export interface Boot {
  runtime: Runtime
  history: Message[]
  warnings: string[]
  shutdown(): Promise<void>
}

export async function boot(options: {
  cwd: string
  continueSession?: boolean
  resumeId?: string
  bypass?: boolean
  mode?: AgentMode
  modelRef?: string
}): Promise<Boot> {
  const config = await loadConfig()
  const auth = await loadAuth()
  const location = await configLocation()
  const warnings: string[] = []

  let registry = createRegistry(config, auth)
  const tools = createToolRegistry(builtinTools())
  const permissions = createPermissionEngine(config.permissions)
  if (options.bypass) permissions.bypass.enable()
  if (options.mode) permissions.mode.set(options.mode)

  const skills = await discoverSkills([projectSkillsDir(options.cwd), skillsDir])
  if (skills.length > 0) tools.register([createSkillTool(skills)])

  const mcp = createMcpManager(config.mcp)
  await mcp.connectAll()
  tools.register(mcp.tools())
  for (const state of mcp.states()) {
    if (state.status === 'error') warnings.push(`MCP "${state.name}": ${state.error ?? 'failed'}`)
  }

  let session: SessionState
  if (options.resumeId) {
    session = await loadSession(await resolveSessionId(options.resumeId))
  } else {
    session =
      (options.continueSession ? await latestSessionFor(options.cwd) : null) ??
      createSession(options.cwd, config.model ?? '')
  }

  const usage = createUsageTracker(session.usage)
  const system = buildSystemPrompt({
    cwd: options.cwd,
    toolNames: tools.list().map((tool) => tool.name),
    skills: formatSkillCatalogue(skills),
  })

  let modelRef = session.model || config.model || ''
  if (options.modelRef) modelRef = options.modelRef
  let contextUsage: ContextUsage | undefined =
    session.context?.model === modelRef ? session.context : undefined
  let modelContextWindow: number | null = null
  const contextListeners = new Set<() => void>()

  const notifyContext = () => {
    for (const listener of contextListeners) listener()
  }

  const knownContextWindow = (ref: string): number | null => {
    const parsed = parseModelRef(ref)
    if (!parsed) return null
    try {
      const found = registry
        .get(parsed.provider)
        .knownModels()
        .find((model) => model.id === parsed.model)
      return found?.contextWindow ?? null
    } catch {
      return null
    }
  }

  const activateModel = (
    ref: string,
    restoredContext?: ContextUsage,
    discoveredWindow?: number,
  ) => {
    modelRef = ref
    contextUsage = restoredContext?.model === ref ? restoredContext : undefined
    modelContextWindow = discoveredWindow ?? knownContextWindow(ref)
    notifyContext()
  }

  modelContextWindow = knownContextWindow(modelRef)

  // Refresh the cached context-window size for the active model.
  async function refreshModelContextWindow(): Promise<void> {
    const targetRef = modelRef
    const parsed = parseModelRef(targetRef)
    if (!parsed) {
      if (modelRef === targetRef) {
        modelContextWindow = null
        notifyContext()
      }
      return
    }
    // Preserve context metadata captured during provider detection when the
    // provider's later /models response is more minimal (common for OpenAI-
    // compatible endpoints).
    let next = modelContextWindow ?? knownContextWindow(targetRef)
    try {
      const provider = registry.get(parsed.provider)
      const models = await loadModels(provider)
      const found = models.find((m) => m.id === parsed.model)
      next = found?.contextWindow ?? next
    } catch {
      // Keep provider-known metadata when discovery or cache refresh fails.
    }
    if (modelRef === targetRef) {
      modelContextWindow = next
      notifyContext()
    }
  }

  const agentConfigFor = (system: string, toolset: ToolLookup): AgentConfig => {
    const resolved = registry.resolve(modelRef)
    const parsed = parseModelRef(modelRef)
    return {
      provider: resolved.provider,
      modelId: resolved.modelId,
      modelRef: parsed ? parsed.model : modelRef,
      system,
      tools: toolset,
      permissions,
      usage,
      cwd: options.cwd,
      maxTokens: config.maxTokens,
      effort: config.effort,
      thinking: config.thinking,
    }
  }

  tools.register([createTaskTool(createSubagentRunner(agentConfigFor, tools))])

  const persistConfig = async (mutate: (draft: Config) => void) => {
    mutate(config)
    await saveConfig(config)
  }

  const runtime: Runtime = {
    cwd: options.cwd,

    needsSetup: () => Object.keys(config.providers).length === 0,

    async addProvider(url, key) {
      const detected = await detectProvider(url, key)
      config.providers[detected.id] = detected.config
      auth[detected.id] = key

      const chosen = preferredModel(detected.models)
      if (chosen) config.model = formatModelRef(detected.id, chosen)

      await saveConfig(config)
      await saveAuth(auth)

      registry = createRegistry(config, auth)
      const nextRef = config.model ?? ''
      const discovered = detected.models.find((model) => model.id === chosen)?.contextWindow
      activateModel(nextRef, undefined, discovered)
      void refreshModelContextWindow()

      const kind = detected.config.type === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'
      return `${detected.id} · ${kind} · ${detected.models.length} models`
    },

    currentProviderId: () => parseModelRef(modelRef)?.provider,

    listProviderItems: () =>
      Object.entries(config.providers).map(([id, entry]) => ({
        key: id,
        label: entry.label ?? id,
        hint: `${entry.type === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · ${entry.baseUrl}`,
      })),

    async useProvider(id) {
      const models = await loadModels(registry.get(id))
      const chosen = preferredModel(models)
      if (!chosen) throw new Error(`"${id}" returned no models to switch to.`)
      const ref = formatModelRef(id, chosen)
      registry.resolve(ref)
      activateModel(ref, undefined, models.find((model) => model.id === chosen)?.contextWindow)
      await persistConfig((draft) => {
        draft.model = ref
      })
      void refreshModelContextWindow()
      return ref
    },

    async logout() {
      const providerId = parseModelRef(modelRef)?.provider
      if (!providerId) return undefined

      delete config.providers[providerId]
      delete auth[providerId]
      config.model = undefined
      activateModel('')

      await saveConfig(config)
      await saveAuth(auth)
      registry = createRegistry(config, auth)
      return providerId
    },

    sessionId: () => session.id,

    async listSessionItems() {
      const entries = await listSessions(30)
      return entries.map((entry) => ({
        key: entry.id,
        label: `${shortSessionId(entry.id)}  ${entry.updatedAt.slice(0, 16).replace('T', ' ')}`,
        hint: `${entry.messageCount} msgs · ${entry.cwd}`,
      }))
    },

    async resumeSession(id) {
      const loaded = await loadSession(await resolveSessionId(id))
      session = loaded
      usage.restore(loaded.usage)
      activateModel(loaded.model || modelRef, loaded.context)
      void refreshModelContextWindow()
      return loaded.messages
    },

    configPath: () => location.path,

    listSkills: () => skills.map((skill) => ({ name: skill.name, description: skill.description })),

    getModelRef: () => modelRef,
    async setModelRef(ref) {
      registry.resolve(ref)
      activateModel(ref)
      await persistConfig((draft) => {
        draft.model = ref
      })
      void refreshModelContextWindow()
    },

    getEffort: () => config.effort,
    async setEffort(effort: Effort) {
      await persistConfig((draft) => {
        draft.effort = effort
      })
    },

    getThinking: () => config.thinking,
    async setThinking(enabled) {
      await persistConfig((draft) => {
        draft.thinking = enabled
      })
    },

    getLang: () => config.lang,
    async setLang(lang: Lang) {
      await persistConfig((draft) => {
        draft.lang = lang
      })
    },

    getAccent: () => config.theme.accent,
    async setAccent(value) {
      await persistConfig((draft) => {
        draft.theme.accent = value
      })
    },

    getMode: () => permissions.mode.get(),
    cycleMode: () => permissions.mode.cycle(),

    isBypassEnabled: () => permissions.bypass.isEnabled(),
    setBypass(enabled) {
      if (enabled) permissions.bypass.enable()
      else permissions.bypass.disable()
    },

    mcpSummary() {
      const states = mcp.states()
      return {
        connected: states.filter((state) => state.status === 'connected').length,
        failed: states.filter((state) => state.status === 'error').length,
      }
    },

    modelContext: () => {
      const used = contextUsage?.model === modelRef ? contextTokens(contextUsage.usage) : 0
      return { window: modelContextWindow, used }
    },

    subscribeContext(listener) {
      contextListeners.add(listener)
      return () => contextListeners.delete(listener)
    },

    resetContext() {
      contextUsage = undefined
      session.context = undefined
      notifyContext()
    },

    usageLine: () => formatUsageCompact(usage),
    usageReport: () => formatUsageBreakdown(usage),
    usageParts: () => usageParts(usage),

    async listModelItems() {
      const items: PickerItem[] = []
      for (const providerId of Object.keys(config.providers)) {
        try {
          const models = await loadModels(registry.get(providerId))
          for (const model of models) {
            items.push({
              key: formatModelRef(providerId, model.id),
              label: formatModelRef(providerId, model.id),
              hint: model.pricing ? `$${model.pricing.input}/$${model.pricing.output}` : undefined,
            })
          }
        } catch {
          warnings.push(`Could not list models for "${providerId}"`)
        }
      }
      return items
    },

    async listPromptItems() {
      const prompts = await listPrompts()
      return prompts.map((prompt) => ({
        key: prompt.slug,
        label: prompt.name,
        hint: prompt.description || undefined,
      }))
    },

    async readPrompt(slug) {
      const prompt = await getPrompt(slug)
      return prompt?.body ?? ''
    },

    async savePrompt(name, body) {
      await savePrompt({ name, body })
    },

    run(history, hooks, signal) {
      const requestModelRef = modelRef
      const trackedHooks: AgentHooks = {
        ...hooks,
        onEvent(event) {
          if (event.type === 'usage') {
            contextUsage = { model: requestModelRef, usage: event.usage }
            notifyContext()
          }
          hooks.onEvent(event)
        },
      }
      return runTurn(agentConfigFor(system, tools), history, trackedHooks, signal)
    },

    async persist(history) {
      session.messages = history
      session.usage = usage.entries()
      session.model = modelRef
      session.context = contextUsage
      await saveSession(session)
    },
  }

  void refreshModelContextWindow()

  return {
    runtime,
    history: session.messages,
    warnings,
    shutdown: () => mcp.close(),
  }
}

function preferredModel(models: ModelInfo[]): string | undefined {
  for (const preferred of PREFERRED) {
    const match = models.find((model) => model.id.endsWith(preferred))
    if (match) return match.id
  }
  return models[0]?.id
}
