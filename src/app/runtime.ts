import { detectProvider } from '../config/detect'
import { formatModelRef, parseModelRef } from '../config/schema'
import type { Config } from '../config/schema'
import { projectSkillsDir, skillsDir } from '../config/paths'
import {
  configLocation,
  loadAuth,
  loadRuntimeConfig,
  resolveApiKey,
  saveAuth,
  saveConfig,
} from '../config/store'
import { canonicalWorkspace, isWorkspaceTrusted } from '../config/trust'
import { runTurn } from '../core/agent'
import type { AgentConfig, ToolLookup } from '../core/agent'
import { createTurnBudget } from '../core/budget'
import type { TurnBudget } from '../core/budget'
import { beginCheckpoint, undoLatestCheckpoint } from '../core/checkpoint'
import type { FileCheckpoint } from '../core/checkpoint'
import { runAutomaticDiagnostics } from '../core/diagnostics'
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
import { fetchProviderBalance } from '../providers/balance'
import { loadModels } from '../providers/catalog'
import { pricingFor } from '../providers/pricing'
import { createRegistry } from '../providers/registry'
import type { Effort, Message, ModelInfo, ModelPricing } from '../providers/types'
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
  const loadedConfig = await loadRuntimeConfig(options.cwd)
  const config = loadedConfig.config
  const auth = await loadAuth()
  const location = await configLocation()
  const warnings: string[] = []
  const workspaceRoot = await canonicalWorkspace(options.cwd)
  const workspaceTrusted = await isWorkspaceTrusted(options.cwd)
  if (loadedConfig.ignoredProject) {
    warnings.push(
      `Project config ignored until this workspace is trusted: ${loadedConfig.ignoredProject.path}. ` +
        `Review it, then run: kitcode trust`,
    )
  }

  let registry = createRegistry(config, auth)
  const modelPricing = new Map<string, ModelPricing>()
  const rememberModels = (providerId: string, models: ModelInfo[]) => {
    for (const model of models) {
      if (model.pricing) modelPricing.set(formatModelRef(providerId, model.id), model.pricing)
    }
  }
  const resolvePricing = (ref: string) => modelPricing.get(ref) ?? pricingFor(ref)
  const tools = createToolRegistry(builtinTools())
  const permissions = createPermissionEngine(config.permissions)
  if (options.bypass) permissions.bypass.enable()
  if (options.mode) permissions.mode.set(options.mode)

  const skillRoots = workspaceTrusted ? [projectSkillsDir(workspaceRoot), skillsDir] : [skillsDir]
  const skills = await discoverSkills(skillRoots)
  if (skills.length > 0) tools.register([createSkillTool(skills)])

  const mcp = createMcpManager(config.mcp)
  await mcp.connectAll()
  let registeredMcpToolNames = new Set<string>()
  const syncMcpTools = () => {
    tools.unregister(registeredMcpToolNames)
    const connected = mcp.tools()
    tools.register(connected)
    registeredMcpToolNames = new Set(
      connected.filter((tool) => tools.get(tool.name) === tool).map((tool) => tool.name),
    )
  }
  syncMcpTools()
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

  const usage = createUsageTracker(session.usage, resolvePricing)
  const skillCatalogue = formatSkillCatalogue(skills)
  const mainSystemPrompt = () =>
    buildSystemPrompt({
      cwd: options.cwd,
      toolNames: tools.list().map((tool) => tool.name),
      skills: skillCatalogue,
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
      const models = registry.get(parsed.provider).knownModels()
      rememberModels(parsed.provider, models)
      const found = models.find((model) => model.id === parsed.model)
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
      rememberModels(parsed.provider, models)
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
    return {
      provider: resolved.provider,
      modelId: resolved.modelId,
      modelRef,
      system,
      tools: toolset,
      permissions,
      usage,
      cwd: options.cwd,
      maxTokens: config.maxTokens,
      effort: config.effort,
      thinking: config.thinking,
      budget: activeBudget,
      checkpoint: activeCheckpoint,
    }
  }

  let activeBudget: TurnBudget | undefined
  let activeCheckpoint: FileCheckpoint | undefined

  tools.register([
    createTaskTool(createSubagentRunner(agentConfigFor, tools), config.budget.maxSubagentsPerTurn),
  ])

  let persistQueue: Promise<void> = Promise.resolve()

  const persistConfig = async (mutate: (draft: Config) => void) => {
    mutate(config)
    await saveConfig(config)
  }

  const runtime: Runtime = {
    cwd: options.cwd,

    needsSetup: () => Object.keys(config.providers).length === 0,

    async addProvider(url, key) {
      const detected = await detectProvider(url, key)
      rememberModels(detected.id, detected.models)
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
      rememberModels(id, models)
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

    mcpServers: () => mcp.states(),

    async addMcpServer(name, server) {
      if (Object.hasOwn(config.mcp, name)) {
        throw new Error(`MCP server "${name}" already exists.`)
      }

      config.mcp[name] = server
      await mcp.reconnect(name)
      const state = mcp.state(name)
      if (!state || state.status !== 'connected') {
        delete config.mcp[name]
        await mcp.remove(name)
        throw new Error(state?.error ?? `MCP server "${name}" did not connect.`)
      }

      try {
        await saveConfig(config)
      } catch (error) {
        delete config.mcp[name]
        await mcp.remove(name)
        throw error
      }

      syncMcpTools()
      return state
    },

    async removeMcpServer(name) {
      const existing = config.mcp[name]
      if (!existing) throw new Error(`MCP server "${name}" does not exist.`)

      delete config.mcp[name]
      try {
        await saveConfig(config)
      } catch (error) {
        config.mcp[name] = existing
        throw error
      }

      await mcp.remove(name)
      syncMcpTools()
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

    undoLastCheckpoint: () =>
      undoLatestCheckpoint({ cwd: options.cwd, sessionId: session.id }),

    usageLine: () => formatUsageCompact(usage),
    usageReport: () => formatUsageBreakdown(usage),
    async providerBalance() {
      const providerId = parseModelRef(modelRef)?.provider
      if (!providerId) return null
      const provider = config.providers[providerId]
      if (!provider) return null
      const key = resolveApiKey(providerId, provider, auth)
      return key ? fetchProviderBalance(provider, key) : null
    },
    usageParts: () => usageParts(usage),

    async listModelItems() {
      const items: PickerItem[] = []
      for (const providerId of Object.keys(config.providers)) {
        try {
          const models = await loadModels(registry.get(providerId))
          rememberModels(providerId, models)
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

    async run(history, hooks, signal) {
      // A server may have closed while KitCode was idle. Refresh the live MCP
      // schemas before building the next prompt so disconnected tools vanish.
      syncMcpTools()
      const requestModelRef = modelRef
      const budget = createTurnBudget(config.budget, resolvePricing)
      const checkpoint = beginCheckpoint({ cwd: options.cwd, sessionId: session.id })
      activeBudget = budget
      activeCheckpoint = checkpoint
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
      try {
        const next = await runTurn(
          agentConfigFor(mainSystemPrompt(), tools),
          history,
          trackedHooks,
          signal,
        )
        if (config.diagnostics.autoRun && !signal.aborted) {
          await runAutomaticDiagnostics({
            cwd: options.cwd,
            changedFiles: checkpoint.changedPaths(),
            configuredCommands: config.diagnostics.commands,
            permissions,
            hooks: trackedHooks,
            signal,
          })
        }
        return next
      } finally {
        try {
          await checkpoint.commit()
        } catch (error) {
          hooks.onEvent({
            type: 'notice',
            level: 'error',
            text: `Could not save the automatic undo checkpoint: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        if (activeCheckpoint === checkpoint) activeCheckpoint = undefined
        if (activeBudget === budget) {
          activeBudget = undefined
        }
      }
    },

    async persist(history) {
      const snapshot: SessionState = {
        ...session,
        messages: history,
        usage: usage.entries(),
        model: modelRef,
        context: contextUsage,
      }
      session = snapshot
      const save = persistQueue.catch(() => undefined).then(() => saveSession(snapshot))
      persistQueue = save
      await save
    },
  }

  void refreshModelContextWindow()

  return {
    runtime,
    history: session.messages,
    warnings,
    async shutdown() {
      try {
        await persistQueue
      } finally {
        await mcp.close()
      }
    },
  }
}

function preferredModel(models: ModelInfo[]): string | undefined {
  for (const preferred of PREFERRED) {
    const match = models.find((model) => model.id.endsWith(preferred))
    if (match) return match.id
  }
  return models[0]?.id
}
