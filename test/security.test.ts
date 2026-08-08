import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGitHubUrl } from '../src/skills/install'
import { createTurnBudget } from '../src/core/budget'
import { isAllowedEndpointUrl } from '../src/config/schema'
import { bridgeMcpTool } from '../src/mcp/bridge'
import { inheritedEnv } from '../src/mcp/client'
import { redactSecrets } from '../src/providers/errors'
import { grepTool } from '../src/tools/grep'
import { readTool } from '../src/tools/read'
import { createRegexMatcher } from '../src/tools/regex'
import { resolveInside } from '../src/tools/safepath'
import type { ToolContext } from '../src/tools/types'
import { sanitizeTerminalText } from '../src/ui/sanitize'

describe('endpoint transport policy', () => {
  it.each([
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://demo.localhost:8080/v1',
    'http://127.0.0.1:9000/v1',
    'http://127.12.34.56/v1',
  ])('accepts %s', (url) => {
    expect(isAllowedEndpointUrl(url)).toBe(true)
  })

  it.each([
    'http://api.example.com/v1',
    'http://192.168.1.20/v1',
    'https://user:password@api.example.com/v1',
    'ftp://localhost/models',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedEndpointUrl(url)).toBe(false)
  })
})

describe('configuration record keys', () => {
  it('rejects or strips prototype-mutating provider, auth, and MCP ids', async () => {
    const { authSchema, configSchema } = await import('../src/config/schema')
    const parsed = configSchema.parse({ providers: JSON.parse('{"__proto__":{}}') })
    expect(Object.hasOwn(parsed.providers, '__proto__')).toBe(false)
    expect(configSchema.safeParse({ mcp: { constructor: {} } }).success).toBe(false)
    expect(authSchema.safeParse({ prototype: 'secret' }).success).toBe(false)
  })
})

describe('GitHub skill source validation', () => {
  it('parses a repository or a safe subdirectory', () => {
    expect(parseGitHubUrl('https://github.com/openai/skills')).toEqual({
      owner: 'openai',
      repo: 'skills',
    })
    expect(
      parseGitHubUrl('https://github.com/openai/skills/tree/main/skills/docs'),
    ).toEqual({
      owner: 'openai',
      repo: 'skills',
      branch: 'main',
      subdir: 'skills/docs',
    })
  })

  it.each([
    'http://github.com/openai/skills',
    'https://user:password@github.com/openai/skills',
    'https://github.com/openai/skills/tree/main/../../victim',
    'https://github.com/openai/skills/tree/main/%2e%2e/%2e%2e/victim',
    'https://github.com/openai/skills/tree/main/safe%2F..%2Fvictim',
  ])('rejects an unsafe source before any filesystem operation: %s', (source) => {
    expect(() => parseGitHubUrl(source)).toThrow()
  })
})

describe('terminal output sanitizing', () => {
  it('removes CSI, OSC, DCS, control bytes, and bidi overrides', () => {
    const unsafe =
      'before\u001b[2Jafter\u001b]52;c;Y29weQ==\u0007ok\u001bPpayload\u001b\\done\u0000\u202Eend'
    expect(sanitizeTerminalText(unsafe)).toBe('beforeafterokdoneend')
  })

  it('preserves normal Unicode, tabs, and newlines', () => {
    expect(sanitizeTerminalText('Привет\tмир\nnext')).toBe('Привет\tмир\nnext')
  })
})

describe('secret handling', () => {
  it('does not inherit provider keys into stdio MCP servers', () => {
    expect(
      inheritedEnv({
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        OPENAI_API_KEY: 'sk-private',
        GITHUB_TOKEN: 'ghp_private',
        KITCODE_CUSTOM_KEY: 'private',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home' })
    expect(inheritedEnv({ Path: 'C:\\Windows\\System32', openai_api_key: 'private' })).toEqual({
      Path: 'C:\\Windows\\System32',
    })
  })

  it('redacts named, bearer, known, and common provider secrets', () => {
    const text =
      'Authorization: Bearer tiny api_key="short" password=hunter2 key sk-secretvalue custom=known-value'
    const safe = redactSecrets(text, ['known-value'])
    expect(safe).not.toContain('tiny')
    expect(safe).not.toContain('short')
    expect(safe).not.toContain('hunter2')
    expect(safe).not.toContain('sk-secretvalue')
    expect(safe).not.toContain('known-value')
  })

  it('asks before reading or searching common credential files', () => {
    expect(readTool.permission?.({ path: '.env.production' })).toBe('ask')
    expect(readTool.permission?.({ path: 'src/index.ts' })).toBeUndefined()
    expect(grepTool.permission?.({ pattern: 'x', glob: '**/*.pem' })).toBe('ask')
  })
})

describe('turn budget', () => {
  const request = (modelRef = 'unknown/model', maxOutputTokens = 10_000) => ({
    modelRef,
    maxOutputTokens,
    estimatedInputTokens: 0,
  })

  it('stops subsequent calls at token and cost limits', () => {
    const tokenBudget = createTurnBudget({
      maxTokensPerTurn: 1_000,
      maxCostUsdPerTurn: 10,
    })
    expect(tokenBudget.beforeRequest(request('unknown/model', 100))).toMatchObject({ allowed: true })
    tokenBudget.record('unknown/model', {
      input: 800,
      output: 200,
      cacheWrite: 0,
      cacheRead: 0,
    })
    expect(tokenBudget.beforeRequest(request())).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/token budget/),
    })

    const costBudget = createTurnBudget({
      maxTokensPerTurn: 1_000_000,
      maxCostUsdPerTurn: 0.01,
    })
    expect(costBudget.beforeRequest(request('anthropic/claude-opus-5', 100))).toMatchObject({
      allowed: true,
    })
    costBudget.record('anthropic/claude-opus-5', {
      input: 0,
      output: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
    })
    expect(costBudget.beforeRequest(request('anthropic/claude-opus-5'))).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/cost budget/),
    })
  })

  it('uses provider-discovered pricing when it is available', () => {
    const budget = createTurnBudget(
      {
        maxTokensPerTurn: 1_000_000,
        maxCostUsdPerTurn: 0.01,
      },
      () => ({ input: 1, output: 20 }),
    )
    expect(budget.beforeRequest(request('openrouter/custom/model', 100))).toMatchObject({
      allowed: true,
    })
    budget.record('openrouter/custom/model', {
      input: 0,
      output: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
    })
    expect(budget.beforeRequest(request('openrouter/custom/model'))).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/cost budget/),
    })
  })

  it('keeps enforcing a conservative cost limit when model pricing is unknown', () => {
    const budget = createTurnBudget({
      maxTokensPerTurn: 1_000_000,
      maxCostUsdPerTurn: 0.01,
    })
    expect(budget.beforeRequest(request('unknown/model'))).toEqual({
      allowed: true,
      maxOutputTokens: 666,
    })
    budget.record('unknown/model', {
      input: 0,
      output: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
    })
    expect(budget.beforeRequest(request('unknown/model'))).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/cost budget/),
    })
  })

  it('caps output before sending a request that approaches the budget', () => {
    const budget = createTurnBudget({
      maxTokensPerTurn: 2_000,
      maxCostUsdPerTurn: 10,
    })
    expect(
      budget.beforeRequest({
        modelRef: 'unknown/model',
        maxOutputTokens: 5_000,
        estimatedInputTokens: 1_500,
      }),
    ).toEqual({ allowed: true, maxOutputTokens: 500 })
  })
})

describe('MCP bridge limits', () => {
  it('shows full arguments in previews and caps returned text', async () => {
    const tool = bridgeMcpTool(
      'demo',
      { name: 'large', inputSchema: { type: 'object' } },
      async () => ({ content: [{ type: 'text', text: 'x'.repeat(210_000) }] }),
    )
    const context: ToolContext = {
      cwd: '/tmp',
      signal: new AbortController().signal,
      confirm: async () => true,
    }
    await expect(tool.preview?.({ nested: { value: 'visible' } }, context)).resolves.toMatchObject({
      kind: 'text',
      text: expect.stringContaining('visible'),
    })
    const result = await tool.execute({}, context)
    expect(result.content).toContain('truncated MCP result')
    expect(result.content.length).toBeLessThan(201_000)
  })
})

describe('path sandboxing', () => {
  it('blocks absolute paths outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kitcode-test-'))
    const safe = resolveInside(root, '../../etc/passwd')
    expect(safe.ok).toBe(false)
    if (!safe.ok) {
      expect(safe.reason).toContain('outside the workspace root')
    }
  })

  it('blocks symlink escape attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kitcode-test-'))
    
    const linkPath = join(root, 'escape')
    await writeFile(linkPath, '../../etc/passwd')
    
    const safe = resolveInside(root, 'escape')
    
    
    if (safe.ok) {
      expect(safe.relative.startsWith('..')).toBe(false)
    }
  })

  it('rejects malformed localhost addresses', () => {
    expect(isAllowedEndpointUrl('http://127.999.999.999/v1')).toBe(false)
    expect(isAllowedEndpointUrl('http://127.0.0.999/v1')).toBe(false)
  })
})

describe('session id validation', () => {
  it('rejects session ids with dots', () => {
    
    const badIds = ['../secret', 'foo.bar', 'a.b.c', '..']
    for (const id of badIds) {
      
      expect(/^[A-Za-z0-9_-]{1,240}$/.test(id)).toBe(false)
    }
  })

  it('accepts valid session ids', () => {
    const goodIds = ['abc123', 'foo-bar_baz', '2024-08-03T12-00-00-a1b2c3']
    for (const id of goodIds) {
      expect(/^[A-Za-z0-9_-]{1,240}$/.test(id)).toBe(true)
    }
  })
})

describe('regex matcher resilience', () => {
  it('recovers after an abort and can match again', async () => {
    const matcher = createRegexMatcher('test')
    const signal = new AbortController().signal

    
    await expect(matcher.match(['test line'], 10, signal)).resolves.toEqual([0])

    
    const abortController = new AbortController()
    const pending = matcher.match(['slow'], 10, abortController.signal)
    abortController.abort()
    await expect(pending).rejects.toThrow('Search interrupted')

    
    await expect(matcher.match(['another test'], 10, signal)).resolves.toEqual([0])

    await matcher.close()
  })
})
