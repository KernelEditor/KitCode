import type { AgentHooks } from '../core/types'
import type { Effort, Message } from '../providers/types'
import type { UsageSummary } from '../core/usage'
import type { Lang } from './i18n'
import type { PickerItem } from './types'

export interface Runtime {
  cwd: string
  needsSetup(): boolean
  addProvider(url: string, key: string): Promise<string>
  currentProviderId(): string | undefined
  listProviderItems(): PickerItem[]
  useProvider(id: string): Promise<string>
  logout(): Promise<string | undefined>
  configPath(): string
  sessionId(): string
  listSessionItems(): Promise<PickerItem[]>
  resumeSession(id: string): Promise<Message[]>
  listSkills(): { name: string; description: string }[]
  getModelRef(): string
  setModelRef(ref: string): Promise<void>
  getEffort(): Effort
  setEffort(effort: Effort): Promise<void>
  getThinking(): boolean
  setThinking(enabled: boolean): Promise<void>
  getLang(): Lang | undefined
  setLang(lang: Lang): Promise<void>
  getAccent(): string
  setAccent(value: string): Promise<void>
  getMode(): string
  cycleMode(): string
  isBypassEnabled(): boolean
  setBypass(enabled: boolean): void
  mcpSummary(): { connected: number; failed: number }
  /** Context-window size and exact usage of the most recent request. */
  modelContext(): { window: number | null; used: number }
  subscribeContext(listener: () => void): () => void
  resetContext(): void
  usageLine(): string
  usageReport(): string
  usageParts(): UsageSummary
  listModelItems(): Promise<PickerItem[]>
  listPromptItems(): Promise<PickerItem[]>
  readPrompt(slug: string): Promise<string>
  savePrompt(name: string, body: string): Promise<void>
  run(history: Message[], hooks: AgentHooks, signal: AbortSignal): Promise<Message[]>
  persist(history: Message[]): Promise<void>
}
