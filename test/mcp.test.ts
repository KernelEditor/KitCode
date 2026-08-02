import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../src/config/schema'
import { parseMcpAddArgs } from '../src/mcp/add'
import { createMcpManager } from '../src/mcp/client'
import { createToolRegistry } from '../src/tools/registry'

describe('/mcp add parsing', () => {
  it('accepts shorthand and explicit remote HTTP servers', () => {
    expect(parseMcpAddArgs(['docs', 'https://mcp.example.com/mcp'])).toEqual({
      ok: true,
      name: 'docs',
      config: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {},
        enabled: true,
      },
    })
    expect(parseMcpAddArgs(['docs', 'http', 'http://localhost:3333/mcp'])).toMatchObject({
      ok: true,
      config: { type: 'http', url: 'http://localhost:3333/mcp' },
    })
  })

  it('accepts local stdio commands without invoking a shell', () => {
    expect(
      parseMcpAddArgs([
        'filesystem',
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
      ]),
    ).toEqual({
      ok: true,
      name: 'filesystem',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: {},
        enabled: true,
      },
    })
  })

  it('rejects unsafe names, remote HTTP, and arguments after an HTTP URL', () => {
    expect(parseMcpAddArgs(['bad name', '--', 'node'])).toEqual({
      ok: false,
      error: 'invalid-name',
    })
    expect(parseMcpAddArgs(['remote', 'http://example.com/mcp'])).toEqual({
      ok: false,
      error: 'invalid-url',
    })
    expect(parseMcpAddArgs(['remote', 'https://example.com/mcp', 'extra'])).toEqual({
      ok: false,
      error: 'http-args',
    })
  })
})

describe('dynamic MCP connections', () => {
  it('connects a server added after startup, exposes its tools, and removes it', async () => {
    const servers: Record<string, McpServerConfig> = {}
    const manager = createMcpManager(servers)
    const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.ts', import.meta.url))
    servers.demo = {
      type: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', fixture],
      env: {},
      enabled: true,
    }

    try {
      await manager.reconnect('demo')
      expect(manager.state('demo')).toMatchObject({
        name: 'demo',
        status: 'connected',
        toolCount: 1,
      })
      const connectedTools = manager.tools()
      expect(connectedTools.map((tool) => tool.name)).toEqual(['mcp__demo__ping'])
      const registry = createToolRegistry([])
      registry.register(connectedTools)
      expect(registry.get('mcp__demo__ping')).toBeDefined()
      await expect(manager.callTool('demo', 'ping', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: 'pong' }],
      })

      await manager.remove('demo')
      registry.unregister(connectedTools.map((tool) => tool.name))
      expect(manager.state('demo')).toBeUndefined()
      expect(manager.tools()).toEqual([])
      expect(registry.get('mcp__demo__ping')).toBeUndefined()
    } finally {
      await manager.close()
    }
  }, 10_000)
})
