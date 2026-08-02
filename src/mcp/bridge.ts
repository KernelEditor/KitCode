import type { CallToolResult, ContentBlock, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { JsonSchema } from '../providers/types'
import type { Tool, ToolResult } from '../tools/types'

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
    execute: (input, ctx) => invoke(call, tool, input, ctx.signal),
  }
}

async function invoke(
  call: McpToolCall,
  tool: string,
  input: unknown,
  signal: AbortSignal,
): Promise<ToolResult> {
  try {
    const result = await call(tool, input, signal)
    return { content: flattenResult(result), isError: result.isError }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

function flattenResult(result: CallToolResult): string {
  const rendered = (result.content ?? []).map(renderPart).join('\n')
  if (rendered) return rendered
  if (result.structuredContent) return JSON.stringify(result.structuredContent)
  return '(no content)'
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
