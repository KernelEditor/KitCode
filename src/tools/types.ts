import type { PermissionDecision, PermissionRequest } from '../core/types'
import type { JsonSchema, ToolSchema } from '../providers/types'

export type PermissionMode = 'allow' | 'ask' | 'deny'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  confirm(question: string): Promise<boolean>
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>
}

export type ToolDisplay =
  | { kind: 'text'; text: string }
  | { kind: 'diff'; path: string; before: string; after: string }
  | { kind: 'list'; title: string; items: string[] }

export interface ToolResult {
  content: string
  isError?: boolean
  display?: ToolDisplay
}

export interface Tool {
  name: string
  description: string
  inputSchema: JsonSchema
  defaultPermission: PermissionMode
  permission?(input: unknown, ctx?: ToolContext): PermissionMode | undefined
  summarize(input: unknown): string
  preview?(input: unknown, ctx: ToolContext): Promise<ToolDisplay | undefined>
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export function toToolSchema(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}
