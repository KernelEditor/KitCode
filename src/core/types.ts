import type { Message, RateLimits, StopReason, Usage } from '../providers/types'
import type { ToolDisplay } from '../tools/types'

export interface PermissionRequest {
  toolName: string
  summary: string
  input: unknown
  display?: ToolDisplay
  allowAlways?: boolean
}

export type PermissionDecision = 'once' | 'always' | 'deny'

export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string }
  | { type: 'tool_end'; id: string; isError: boolean; content: string; display?: ToolDisplay }
  | { type: 'usage'; model: string; usage: Usage }
  | { type: 'rate_limits'; model: string; limits: RateLimits }
  | { type: 'turn_end'; stopReason: StopReason }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }

export interface AgentHooks {
  onEvent(event: AgentEvent): void
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>
}

export interface UsageEntry {
  model: string
  usage: Usage
  requests: number
  costUsd: number | null
}

export interface ContextUsage {
  /** Full provider/model reference used for the request. */
  model: string
  /** Usage of the most recent model request, not cumulative session usage. */
  usage: Usage
}

export interface SessionState {
  id: string
  title?: string
  cwd: string
  createdAt: string
  updatedAt: string
  model: string
  messages: Message[]
  usage: UsageEntry[]
  context?: ContextUsage
}
