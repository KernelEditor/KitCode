import { detectProvider } from '../config/detect'
import { formatModelRef, parseModelRef } from '../config/schema'
import type { Config } from '../config/schema'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
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
import {
  loadAttachment,
  loadAutomaticAttachment,
  loadClipboardImage as readClipboardImage,
} from '../core/attachments'
import {
  compactCutIndex,
  compactHistory,
  estimateCompactTokens,
  shouldAutoCompact,
} from '../core/compact'
import { buildSystemPrompt } from '../core/prompt'
import {
  createSession,
  deleteAllSessions as deleteAllStoredSessions,
  deleteSession as deleteStoredSession,
  exportSession as exportStoredSession,
  latestSessionFor,
  listSessions,
  loadSession,
  renameSession as renameStoredSession,
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
import { formatRateLimits } from '../providers/rate-limits'
import type { Effort, Message, ModelInfo, ModelPricing, RateLimits } from '../providers/types'
import { createPermissionEngine } from '../tools/permissions'
import type { AgentMode } from '../tools/permissions'
import { builtinTools, createToolRegistry } from '../tools/registry'
import { deletePrompt, getPrompt, listPrompts, promptExists, savePrompt } from '../prompts/library'
import { discoverSkills, formatSkillCatalogue, loadSkill } from '../skills/library'
import { installSkill } from '../skills/install'
import { createSkillTool } from '../tools/skill'
import { createTaskTool } from '../tools/task'
import type { Lang } from '../ui/i18n'
import type { Runtime } from '../ui/runtime'
import type { PickerItem } from '../ui/types'
import { checkForUpdates } from '../core/update'
import { KITCODE_COMMIT, KITCODE_VERSION } from '../version'

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
  const startupUpdate = config.updates.checkOnStart ? checkForUpdates() : null
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
  let skills = await discoverSkills(skillRoots)
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
  let latestRateLimits: { model: string; limits: RateLimits } | undefined
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
    if (latestRateLimits?.model !== ref) latestRateLimits = undefined
    contextUsage = restoredContext?.model === ref ? restoredContext : undefined
    modelContextWindow = discoveredWindow ?? knownContextWindow(ref)
    notifyContext()
  }

  modelContextWindow = knownContextWindow(modelRef)

  
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
    
    
    
    let next = modelContextWindow ?? knownContextWindow(targetRef)
    try {
      const provider = registry.get(parsed.provider)
      const models = await loadModels(provider)
      rememberModels(parsed.provider, models)
      const found = models.find((m) => m.id === parsed.model)
      next = found?.contextWindow ?? next
    } catch {
      
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
  let activeAgentCount = 0
  const activeAgents: { description: string; progress: string[] }[] = []

  const subagentRunner = createSubagentRunner(agentConfigFor, tools)
  const wrappedRunner = {
    run: async (request: import('../core/subagent').SubagentRequest): Promise<string> => {
      activeAgentCount += 1
      const entry = { description: request.description ?? '', progress: [] as string[] }
      activeAgents.push(entry)
      const trackedRequest = {
        ...request,
        onProgress: (summary: string) => {
          entry.progress.push(summary)
          request.onProgress(summary)
        },
      }
      try {
        return await subagentRunner.run(trackedRequest)
      } finally {
        activeAgentCount = Math.max(0, activeAgentCount - 1)
        const idx = activeAgents.indexOf(entry)
        if (idx !== -1) activeAgents.splice(idx, 1)
      }
    },
  }

  tools.register([
    createTaskTool(wrappedRunner, config.budget.maxSubagentsPerTurn),
  ])

  let persistQueue: Promise<void> = Promise.resolve()

  const persistConfig = async (mutate: (draft: Config) => void) => {
    mutate(config)
    await saveConfig(config)
  }

  const compactWithBudget = async (
    history: Message[],
    signal: AbortSignal,
    budget: TurnBudget,
  ) => {
    if (compactCutIndex(history) <= 0) {
      return { history, compacted: false as const, removedMessages: 0 }
    }
    const resolved = registry.resolve(modelRef)
    const budgetDecision = budget.beforeRequest({
      modelRef,
      maxOutputTokens: Math.min(4_096, config.maxTokens),
      estimatedInputTokens: estimateCompactTokens(history),
    })
    if (!budgetDecision.allowed) throw new Error(budgetDecision.reason)
    const result = await compactHistory({
      provider: resolved.provider,
      model: resolved.modelId,
      history,
      maxTokens: budgetDecision.maxOutputTokens,
      signal,
    })
    if (result.usage) {
      budget.record(modelRef, result.usage)
      usage.record(modelRef, result.usage)
    }
    if (result.rateLimits) latestRateLimits = { model: modelRef, limits: result.rateLimits }
    if (result.compacted) {
      contextUsage = undefined
      session.context = undefined
      notifyContext()
    }
    return result
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

    async logout(providerId) {
      const provider = config.providers[providerId]
      if (!provider) throw new Error(`Provider "${providerId}" is not configured.`)
      const previousKey = auth[providerId]
      const previousModel = config.model
      const previousActiveModel = modelRef
      const wasActive = parseModelRef(modelRef)?.provider === providerId
      const configuredWasRemoved = parseModelRef(config.model ?? '')?.provider === providerId

      delete config.providers[providerId]
      delete auth[providerId]
      if (configuredWasRemoved) {
        config.model =
          !wasActive && config.providers[parseModelRef(modelRef)?.provider ?? ''] ? modelRef : undefined
      }
      registry = createRegistry(config, auth)

      let nextModel: string | undefined
      if (wasActive) {
        if (config.model) {
          try {
            registry.resolve(config.model)
            nextModel = config.model
          } catch {
            config.model = undefined
          }
        }
        if (!nextModel) {
          for (const remaining of Object.keys(config.providers)) {
            try {
              const models = await loadModels(registry.get(remaining))
              rememberModels(remaining, models)
              const chosen = preferredModel(models)
              if (!chosen) continue
              nextModel = formatModelRef(remaining, chosen)
              config.model = nextModel
              break
            } catch {
              
            }
          }
        }
      }

      try {
        await saveConfig(config)
        await saveAuth(auth)
      } catch (error) {
        config.providers[providerId] = provider
        if (previousKey !== undefined) auth[providerId] = previousKey
        config.model = previousModel
        registry = createRegistry(config, auth)
        if (wasActive) activateModel(previousActiveModel)
        await Promise.allSettled([saveConfig(config), saveAuth(auth)])
        throw error
      }

      if (wasActive) {
        activateModel(nextModel ?? '')
        if (nextModel) void refreshModelContextWindow()
      }
      return { removed: providerId, wasActive, ...(nextModel ? { nextModel } : {}) }
    },

    async changeProviderKey(providerId, newKey) {
      const provider = config.providers[providerId]
      if (!provider) throw new Error(`Provider "${providerId}" is not configured.`)

      const previousKey = auth[providerId]
      auth[providerId] = newKey

      try {
        const testRegistry = createRegistry(config, auth)
        await loadModels(testRegistry.get(providerId))
      } catch (error) {
        auth[providerId] = previousKey
        throw new Error(
          `Key verification failed for "${providerId}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      await saveAuth(auth)
      registry = createRegistry(config, auth)
      if (parseModelRef(modelRef)?.provider === providerId) {
        const models = await loadModels(registry.get(providerId))
        rememberModels(providerId, models)
        void refreshModelContextWindow()
      }
    },

    sessionId: () => session.id,

    async newSession() {
      await persistQueue.catch(() => undefined)
      session = createSession(options.cwd, modelRef)
      usage.reset()
      contextUsage = undefined
      latestRateLimits = undefined
      notifyContext()
      return session.id
    },

    async listSessionItems() {
      await persistQueue.catch(() => undefined)
      const entries = await listSessions(30)
      return entries.map((entry) => ({
        key: entry.id,
        label: entry.title || `${shortSessionId(entry.id)}  ${entry.updatedAt.slice(0, 16).replace('T', ' ')}`,
        hint: `${entry.updatedAt.slice(0, 16).replace('T', ' ')} · ${entry.messageCount} msgs · ${entry.cwd}`,
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

    async renameSession(id, title) {
      await persistQueue.catch(() => undefined)
      const renamed = await renameStoredSession(id, title)
      if (renamed.id === session.id) session = renamed
      return renamed.title ?? shortSessionId(renamed.id)
    },

    async deleteSession(id) {
      await persistQueue.catch(() => undefined)
      const resolved = await resolveSessionId(id)
      const wasActive = resolved === session.id
      await deleteStoredSession(resolved)
      if (!wasActive) return { id: resolved, wasActive: false }

      session = createSession(options.cwd, modelRef)
      usage.restore([])
      contextUsage = undefined
      latestRateLimits = undefined
      notifyContext()
      return { id: resolved, wasActive: true, newSessionId: session.id }
    },

    async deleteAllSessions() {
      await persistQueue.catch(() => undefined)
      const result = await deleteAllStoredSessions()
      session = createSession(options.cwd, modelRef)
      usage.restore([])
      contextUsage = undefined
      latestRateLimits = undefined
      notifyContext()
      return { deleted: result.deleted.length, failed: result.failed }
    },

    async exportSession(id, destination) {
      await persistQueue.catch(() => undefined)
      const target = destination
        ? path.resolve(options.cwd, destination)
        : path.join(options.cwd, '.kitcode-exports')
      if (!destination) await mkdir(target, { recursive: true, mode: 0o700 })
      return (await exportStoredSession(id, target)).path
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

    getMaxTokensPerTurn: () => config.budget.maxTokensPerTurn,
    async setMaxTokensPerTurn(tokens: number) {
      await persistConfig((draft) => {
        draft.budget.maxTokensPerTurn = tokens
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

    activeAgentsCount: () => activeAgentCount,

    activeAgentsList: () => activeAgents.map((a) => ({
      description: a.description,
      progress: [...a.progress],
    })),

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

    async setMcpEnabled(name, enabled) {
      const existing = config.mcp[name]
      if (!existing) throw new Error(`MCP server "${name}" does not exist.`)
      const previous = existing.enabled
      existing.enabled = enabled
      try {
        await saveConfig(config)
        await mcp.reconnect(name)
      } catch (error) {
        existing.enabled = previous
        await saveConfig(config).catch(() => undefined)
        await mcp.reconnect(name).catch(() => undefined)
        throw error
      }
      syncMcpTools()
      const state = mcp.state(name)
      if (!state) throw new Error(`MCP server "${name}" disappeared.`)
      return state
    },

    modelContext: () => {
      const exact = contextUsage?.model === modelRef
      const used = exact && contextUsage ? contextTokens(contextUsage.usage) : 0
      return { window: modelContextWindow, used, exact }
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
    rateLimitsReport() {
      if (!latestRateLimits || latestRateLimits.model !== modelRef) return null
      const lines = formatRateLimits(latestRateLimits.limits)
      return lines.length > 0 ? `rate limits\n${lines.join('\n')}` : null
    },
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

    async deletePrompt(slug) {
      const ok = await deletePrompt(slug)
      if (!ok) throw new Error(`Prompt "${slug}" not found.`)
    },

    async loadSkill(name) {
      const meta = skills.find((s) => s.name === name)
      if (!meta) throw new Error(`Skill "${name}" not found.`)
      return (await loadSkill(meta)).body
    },

    async installSkill(source) {
      const result = await installSkill(source)
      
      skills = await discoverSkills(skillRoots)
      return result
    },

    async loadAttachment(requestedPath) {
      return (await loadAttachment(options.cwd, requestedPath)).block
    },

    async loadAutomaticAttachment(requestedPath) {
      return (await loadAutomaticAttachment(options.cwd, requestedPath))?.block ?? null
    },

    async loadClipboardImage() {
      return readClipboardImage()
    },

    async compact(history, signal) {
      return compactWithBudget(history, signal, createTurnBudget(config.budget, resolvePricing))
    },

    async checkerReport() {
      const providerId = parseModelRef(modelRef)?.provider
      const provider = providerId ? config.providers[providerId] : undefined
      const states = mcp.states()
      const lines = [
        `KitCode ${KITCODE_VERSION} · ${KITCODE_COMMIT.slice(0, 12)}`,
        `updates: ${config.updates.checkOnStart ? 'enabled' : 'disabled'}`,
        `runtime: Node ${process.versions.node} · ${process.platform}/${process.arch}`,
        `workspace: ${options.cwd}`,
        `config: ${location.path}`,
        `session: ${shortSessionId(session.id)} · ${session.messages.length} messages`,
        `model: ${modelRef || 'not selected'}`,
      ]
      if (providerId && provider) {
        lines.push(
          `provider: ${provider.label ?? providerId} · ${provider.type} · ${provider.baseUrl}`,
        )
        try {
          const models = await registry.get(providerId).listModels()
          rememberModels(providerId, models)
          lines.push(`provider check: ok · ${models.length} models`)
        } catch (error) {
          lines.push(`provider check: failed · ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        lines.push('provider check: not configured')
      }
      const context = runtime.modelContext()
      lines.push(
        `context: ${context.exact ? context.used : 'unknown'} / ${context.window ?? 'unknown'}`,
        `MCP: ${states.filter((state) => state.status === 'connected').length} connected · ${states.filter((state) => state.status === 'disabled').length} disabled · ${states.filter((state) => state.status === 'error').length} failed`,
      )
      return lines.join('\n')
    },

    startupUpdateCheck: () => startupUpdate,

    async run(history, hooks, signal) {
      syncMcpTools()
      const runProviderId = parseModelRef(modelRef)?.provider
      if (runProviderId) {
        try {
          const models = await loadModels(registry.get(runProviderId))
          rememberModels(runProviderId, models)
        } catch (error) {
          warnings.push(
            `Could not refresh models for "${runProviderId}": ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      let requestHistory = history
      const budget = createTurnBudget(config.budget, resolvePricing)
      const previousContext = runtime.modelContext()
      if (shouldAutoCompact(previousContext.used, previousContext.window)) {
        hooks.onEvent({ type: 'notice', level: 'info', text: 'Context is 80% full; compacting older messages…' })
        try {
          const result = await compactWithBudget(requestHistory, signal, budget)
          if (result.compacted) {
            requestHistory = result.history
            hooks.onEvent({
              type: 'notice',
              level: 'info',
              text: `Compacted older context; kept the latest conversation (${result.removedMessages} messages replaced).`,
            })
          }
        } catch (error) {
          if (signal.aborted) return history
          hooks.onEvent({
            type: 'notice',
            level: 'warn',
            text: `Automatic context compaction failed; continuing with the original context: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
      const requestModelRef = modelRef
      const checkpoint = beginCheckpoint({ cwd: options.cwd, sessionId: session.id })
      activeBudget = budget
      activeCheckpoint = checkpoint
      const trackedHooks: AgentHooks = {
        ...hooks,
        onEvent(event) {
          if (event.type === 'turn_start') {
            contextUsage = undefined
            notifyContext()
          }
          if (event.type === 'usage') {
            contextUsage = { model: requestModelRef, usage: event.usage }
            notifyContext()
          }
          if (event.type === 'rate_limits') {
            latestRateLimits = { model: requestModelRef, limits: event.limits }
          }
          hooks.onEvent(event)
        },
      }
      try {
        const next = await runTurn(
          agentConfigFor(mainSystemPrompt(), tools),
          requestHistory,
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
