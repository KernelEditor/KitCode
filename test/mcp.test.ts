import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../src/config/schema'
import { parseMcpAddArgs, parseMcpAddCommand } from '../src/mcp/add'
import { bridgeMcpTool, mcpToolName } from '../src/mcp/bridge'
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

describe('/mcp add options', () => {
  it('keeps quoted paths and takes env and headers', () => {
    expect(parseMcpAddCommand('fs -e ROOT="C:\My Docs" -- npx -y server "C:\My Docs"')).toMatchObject({
      ok: true,
      config: { type: 'stdio', command: 'npx', args: ['-y', 'server', 'C:\My Docs'], env: { ROOT: 'C:\My Docs' } },
    })
    expect(
      parseMcpAddCommand('gh -H "Authorization: Bearer ${env:GH_TOKEN}" https://api.example.com/mcp'),
    ).toMatchObject({
      ok: true,
      config: { type: 'http', headers: { Authorization: 'Bearer ${env:GH_TOKEN}' } },
    })
  })

  it('rejects malformed options and an unclosed quote', () => {
    expect(parseMcpAddCommand('x -e NOVALUE -- node')).toEqual({ ok: false, error: 'invalid-env' })
    expect(parseMcpAddCommand('x -H nocolon https://a.example/mcp')).toEqual({ ok: false, error: 'invalid-header' })
    expect(parseMcpAddCommand('x -e A=1 https://a.example/mcp')).toEqual({ ok: false, error: 'option-mismatch' })
    expect(parseMcpAddCommand('x -H "A: 1" -- node')).toEqual({ ok: false, error: 'option-mismatch' })
    expect(parseMcpAddCommand('x -- node "open')).toEqual({ ok: false, error: 'usage' })
  })
})

describe('MCP tool bridging', () => {
  it('produces names every provider accepts and keeps them distinct', () => {
    const valid = /^[a-zA-Z0-9_-]{1,64}$/
    expect(mcpToolName('docs', 'search')).toBe('mcp__docs__search')
    const dotted = mcpToolName('docs', 'files.read')
    const long = mcpToolName('a-very-long-server-name-for-testing', 'an_equally_long_tool_name_that_overflows')
    expect(dotted).toMatch(valid)
    expect(long).toMatch(valid)
    expect(dotted).not.toBe(mcpToolName('docs', 'files_read'))
    expect(dotted.startsWith('mcp__')).toBe(true)
  })

  it('calls the server with the original tool name and an object schema', async () => {
    const called: string[] = []
    const tool = bridgeMcpTool('docs', { name: 'files.read', inputSchema: {} } as never, async (name) => {
      called.push(name)
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: {} })
    await tool.execute({}, { cwd: '.', signal: new AbortController().signal, confirm: async () => true })
    expect(called).toEqual(['files.read'])
  })
})

describe('dynamic MCP connections', () => {
  it('connects a server added after startup, exposes its tools, and removes it', async () => {
    const servers: Record<string, McpServerConfig> = {}
    const manager = createMcpManager(servers)
    const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url))
    servers.demo = {
      type: 'stdio',
      command: process.execPath,
      args: [fixture],
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
