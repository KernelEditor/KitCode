import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '../config/schema'
import { expandEnvRecord } from '../config/store'
import { redactSecrets } from '../providers/errors'
import type { Tool } from '../tools/types'
import { bridgeMcpTool } from './bridge'

export type McpStatus = 'connected' | 'connecting' | 'error' | 'disabled'

export interface McpServerState {
  name: string
  status: McpStatus
  toolCount: number
  error?: string
}

const clientInfo = { name: 'kitcode', version: '0.1.0' }
const connectTimeoutMs = 15_000
const stderrTailLimit = 400
const maxToolPages = 20
const maxTools = 256

const inheritedEnvKeys = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
])

interface Session {
  client: Client
  tools: Tool[]
}

export function createMcpManager(servers: Record<string, McpServerConfig>) {
  const serverStates = new Map<string, McpServerState>()
  const sessions = new Map<string, Session>()

  for (const [name, config] of Object.entries(servers)) {
    serverStates.set(name, {
      name,
      status: config.enabled ? 'connecting' : 'disabled',
      toolCount: 0,
    })
  }

  async function callTool(
    server: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const session = sessions.get(server)
    if (!session) throw new Error(`MCP server "${server}" is not connected`)
    const result = await session.client.callTool(
      { name: tool, arguments: args as Record<string, unknown> },
      undefined,
      { signal },
    )
    return result as CallToolResult
  }

  async function connect(name: string, config: McpServerConfig): Promise<void> {
    serverStates.set(name, { name, status: 'connecting', toolCount: 0 })
    const client = new Client(clientInfo)
    client.onclose = () => {
      if (sessions.delete(name)) {
        serverStates.set(name, {
          name,
          status: 'error',
          toolCount: 0,
          error: 'connection closed',
        })
      }
    }
    const transport = createTransport(config)
    const stderrTail = captureStderr(transport)
    try {
      const descriptors = await withTimeout(
        handshake(client, transport),
        `timed out after ${connectTimeoutMs / 1000}s`,
      )
      const tools = descriptors.map((descriptor) =>
        bridgeMcpTool(name, descriptor, (tool, args, signal) => callTool(name, tool, args, signal)),
      )
      sessions.set(name, { client, tools })
      serverStates.set(name, { name, status: 'connected', toolCount: tools.length })
    } catch (error) {
      await client.close().catch(() => {})
      serverStates.set(name, {
        name,
        status: 'error',
        toolCount: 0,
        error: describeFailure(error, stderrTail(), configuredSecrets(config)),
      })
    }
  }

  async function disconnect(name: string): Promise<void> {
    const session = sessions.get(name)
    if (!session) return
    sessions.delete(name)
    await session.client.close().catch(() => {})
  }

  return {
    async connectAll(): Promise<void> {
      const enabled = Object.entries(servers).filter(([, config]) => config.enabled)
      await Promise.all(enabled.map(([name, config]) => connect(name, config)))
    },

    async reconnect(name: string): Promise<void> {
      const config = servers[name]
      if (!config) return
      await disconnect(name)
      if (!config.enabled) {
        serverStates.set(name, { name, status: 'disabled', toolCount: 0 })
        return
      }
      await connect(name, config)
    },

    async remove(name: string): Promise<void> {
      await disconnect(name)
      serverStates.delete(name)
    },

    async close(): Promise<void> {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.all(open.map((session) => session.client.close().catch(() => {})))
    },

    states(): McpServerState[] {
      return [...serverStates.values()]
    },

    state(name: string): McpServerState | undefined {
      return serverStates.get(name)
    },

    tools(): Tool[] {
      return [...sessions.values()].flatMap((session) => session.tools)
    },

    callTool,
  }
}

export type McpManager = ReturnType<typeof createMcpManager>

async function handshake(client: Client, transport: McpTransport): Promise<McpTool[]> {
  await client.connect(transport, { timeout: connectTimeoutMs })
  const collected: McpTool[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    if (++pages > maxToolPages) throw new Error(`MCP tool listing exceeded ${maxToolPages} pages`)
    const page = await client.listTools({ cursor })
    collected.push(...page.tools)
    if (collected.length > maxTools) throw new Error(`MCP server exposed more than ${maxTools} tools`)
    cursor = page.nextCursor
  } while (cursor)
  return collected
}

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport

function createTransport(config: McpServerConfig): McpTransport {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...inheritedEnv(), ...expandEnvRecord(config.env) },
      stderr: 'pipe',
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: expandEnvRecord(config.headers) },
  })
}

function captureStderr(transport: McpTransport): () => string {
  if (!(transport instanceof StdioClientTransport)) return () => ''
  let tail = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-stderrTailLimit)
  })
  return () => tail.trim()
}

function describeFailure(error: unknown, stderr: string, secrets: string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSecrets(stderr ? `${message} — ${stderr}` : message, secrets)
}

function configuredSecrets(config: McpServerConfig): string[] {
  const record = config.type === 'stdio' ? config.env : config.headers
  return Object.values(expandEnvRecord(record)).filter((value) => value.length >= 4)
}

export function inheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && inheritedEnvKeys.has(key)) env[key] = value
  }
  return env
}

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), connectTimeoutMs)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}
