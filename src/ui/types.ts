import type { PermissionDecision, PermissionRequest } from '../core/types'
import type { UsageSummary } from '../core/usage'
import type { Effort } from '../providers/types'
import type { ToolDisplay } from '../tools/types'

export type ToolState = 'running' | 'ok' | 'error'

export type Bubble =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      summary: string
      state: ToolState
      content: string
      display?: ToolDisplay
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }

export interface StatusView {
  modelRef: string
  effort: Effort
  thinking: boolean
  usage: UsageSummary | null
  mcp: { connected: number; failed: number }
  mode: string
  bypass: boolean
  busy: boolean
  sessionMs: number
  turnMs: number | null
  /** Model context window and tokens used by the most recent request. */
  context: { window: number | null; used: number }
}

export interface PickerItem {
  key: string
  label: string
  hint?: string
}

export interface TranscriptProps {
  bubbles: Bubble[]
}

export interface StatusBarProps {
  status: StatusView
}

export interface PromptInputProps {
  value: string
  onChange(value: string): void
  onSubmit(value: string): void
  disabled: boolean
  pending?: number
  hint?: string
  history: string[]
}

export interface PermissionPromptProps {
  request: PermissionRequest
  onDecide(decision: PermissionDecision): void
}

export interface PickerProps {
  title: string
  items: PickerItem[]
  onSelect(key: string): void
  onCancel(): void
}

export interface ConfirmProps {
  title: string
  body?: string
  danger?: boolean
  onAnswer(yes: boolean): void
}
