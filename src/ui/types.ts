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
  | {
      kind: 'subagent'
      id: string
      description: string
      state: 'running' | 'done'
      result?: string
      seq: number
      bubbles: Bubble[]
    }

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
  activeAgents: number
  context: { window: number | null; used: number; exact: boolean }
}

export interface PickerItem {
  key: string
  label: string
  hint?: string
}

export interface TranscriptProps {
  bubbles: Bubble[]
  workspace: string
}

export interface StatusBarProps {
  status: StatusView
}

export interface PromptInputProps {
  value: string
  onChange(value: string): void
  onSubmit(value: string): void
  
  onPastePath?(value: string): Promise<boolean>
  onPasteImage?(): void
  disabled: boolean
  pending?: number
  hint?: string
  history: string[]
  attachments?: string[]
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
