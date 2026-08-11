import type { AgentHooks } from '../core/types'
import type { UndoResult } from '../core/checkpoint'
import type { McpServerConfig } from '../config/schema'
import type { McpServerState } from '../mcp/client'
import type { ProviderBalance } from '../providers/balance'
import type { Effort, Message } from '../providers/types'
import type { ContentBlock } from '../providers/types'
import type { UsageSummary } from '../core/usage'
import type { CompactResult } from '../core/compact'
import type { UpdateCheck } from '../core/update'
import type { Lang } from './i18n'
import type { PickerItem } from './types'

export interface Runtime {
  cwd: string
  needsSetup(): boolean
  addProvider(url: string, key: string): Promise<string>
  currentProviderId(): string | undefined
  listProviderItems(): PickerItem[]
  useProvider(id: string): Promise<string>
  logout(providerId: string): Promise<{
    removed: string
    wasActive: boolean
    nextModel?: string
  }>
  changeProviderKey(providerId: string, newKey: string): Promise<void>
  configPath(): string
  sessionId(): string
  newSession(): Promise<string>
  listSessionItems(): Promise<PickerItem[]>
  resumeSession(id: string): Promise<Message[]>
  renameSession(id: string, title: string): Promise<string>
  deleteSession(id: string): Promise<{ id: string; wasActive: boolean; newSessionId?: string }>
  deleteAllSessions(): Promise<{ deleted: number; failed: Array<{ id: string; error: string }> }>
  exportSession(id: string, destination?: string): Promise<string>
  listSkills(): { name: string; description: string }[]
  installSkill(source: string): Promise<{ name: string; dir: string; source: string }>
  getModelRef(): string
  setModelRef(ref: string): Promise<void>
  getEffort(): Effort
  setEffort(effort: Effort): Promise<void>
  getThinking(): boolean
  setThinking(enabled: boolean): Promise<void>
  getMaxTokensPerTurn(): number
  setMaxTokensPerTurn(tokens: number): Promise<void>
  getLang(): Lang | undefined
  setLang(lang: Lang): Promise<void>
  getAccent(): string
  setAccent(value: string): Promise<void>
  getMode(): string
  cycleMode(): string
  isBypassEnabled(): boolean
  setBypass(enabled: boolean): void
  mcpSummary(): { connected: number; failed: number }
  activeAgentsCount(): number
  activeAgentsList(): { description: string; progress: string[] }[]
  mcpServers(): McpServerState[]
  addMcpServer(name: string, config: McpServerConfig): Promise<McpServerState>
  removeMcpServer(name: string): Promise<void>
  setMcpEnabled(name: string, enabled: boolean): Promise<McpServerState>
  
  modelContext(): { window: number | null; used: number; exact: boolean }
  subscribeContext(listener: () => void): () => void
  resetContext(): void
  undoLastCheckpoint(): Promise<UndoResult>
  usageLine(): string
  usageReport(): string
  rateLimitsReport(): string | null
  providerBalance(): Promise<ProviderBalance[] | null>
  usageParts(): UsageSummary
  listModelItems(): Promise<PickerItem[]>
  listPromptItems(): Promise<PickerItem[]>
  readPrompt(slug: string): Promise<string>
  savePrompt(name: string, body: string): Promise<void>
  deletePrompt(slug: string): Promise<void>
  loadSkill(name: string): Promise<string>
  loadAttachment(path: string): Promise<ContentBlock>
  loadAutomaticAttachment(path: string): Promise<ContentBlock | null>
  loadClipboardImage(): Promise<ContentBlock>
  compact(history: Message[], signal: AbortSignal): Promise<CompactResult>
  checkerReport(): Promise<string>
  startupUpdateCheck(): Promise<UpdateCheck>
  checkForUpdates(): Promise<UpdateCheck>
  run(history: Message[], hooks: AgentHooks, signal: AbortSignal): Promise<Message[]>
  persist(history: Message[]): Promise<void>
}
