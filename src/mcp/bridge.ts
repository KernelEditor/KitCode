import type { CallToolResult, ContentBlock, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchema } from '../providers/types'
import { redactSecrets } from '../providers/errors'
import type { Tool, ToolResult } from '../tools/types'

const MAX_RESULT_CHARS = 200_000

export type McpToolCall = (
  tool: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<CallToolResult>

export function bridgeMcpTool(server: string, descriptor: McpTool, call: McpToolCall): Tool {
  const tool = descriptor.name
  return {
    name: `mcp__${server}__${tool}`,
    description: descriptor.description ?? descriptor.title ?? tool,
    inputSchema: inputSchemaOf(descriptor),
    defaultPermission: 'ask',
    summarize: (input) => `${server}:${tool}${argumentPreview(input)}`,
    preview: async (input) => ({ kind: 'text', text: printableInput(input) }),
    execute: (input, ctx) => invoke(call, tool, input, ctx.signal),
  }
}

function printableInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

async function invoke(
  call: McpToolCall,
  tool: string,
  input: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  try {
    // Validate input is a plain object (not null, not array, not primitive)
    if (input !== null && typeof input !== 'object' || Array.isArray(input)) {
      return { content: `MCP tool "${tool}" received invalid input: arguments must be a JSON object.`, isError: true }
    }
    const result = await call(tool, input ?? {}, signal)
    return { content: flattenResult(result), isError: result.isError }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Redact potential secrets from error messages
    return { content: redactSecrets(message), isError: true }
  }
}

function flattenResult(result: CallToolResult): string {
  const rendered = (result.content ?? []).map(renderPart).join('\n')
  const value = rendered || (result.structuredContent ? JSON.stringify(result.structuredContent) : '(no content)')
  if (value.length <= MAX_RESULT_CHARS) return value
  return `${value.slice(0, MAX_RESULT_CHARS)}\n... truncated MCP result at ${MAX_RESULT_CHARS} characters`
}

function renderPart(part: ContentBlock): string {
  if (part.type === 'text') return part.text
  if (part.type === 'resource') {
    return 'text' in part.resource ? part.resource.text : `[resource ${part.resource.uri}]`
  }
  if (part.type === 'resource_link') return `[resource ${part.uri}]`
  return `[${part.type}]`
}

function inputSchemaOf(descriptor: McpTool): JsonSchema {
  const schema: unknown = descriptor.inputSchema
  if (schema === null || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  return schema as JsonSchema
}

function argumentPreview(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return ''
  const shown = entries.slice(0, 3).map(([key, value]) => `${key}=${clip(value)}`)
  if (entries.length > shown.length) shown.push('…')
  return `(${shown.join(' ')})`
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') return String(value)
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}
