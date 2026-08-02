import type { ToolSchema } from '../providers/types'
import { bashTool } from './bash'
import { editTool } from './edit'
import { globTool } from './glob'
import { grepTool } from './grep'
import { readTool } from './read'
import { toToolSchema } from './types'
import type { Tool } from './types'
import { writeTool } from './write'

export interface ToolRegistry {
  get(name: string): Tool | undefined
  list(): Tool[]
  schemas(): ToolSchema[]
  register(tools: Tool[]): void
}

export function builtinTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, globTool, grepTool]
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>()

  const register = (incoming: Tool[]) => {
    for (const tool of incoming) {
      if (!byName.has(tool.name)) byName.set(tool.name, tool)
    }
  }
  register(tools)

  return {
    get: (name) => byName.get(name),
    list: () => [...byName.values()],
    schemas: () => [...byName.values()].map(toToolSchema),
    register,
  }
}
