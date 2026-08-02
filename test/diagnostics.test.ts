import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/config/schema'
import type { PermissionGate } from '../src/core/agent'
import {
  detectDiagnosticCommands,
  runAutomaticDiagnostics,
} from '../src/core/diagnostics'
import type { AgentEvent, AgentHooks } from '../src/core/types'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'kitcode-diagnostics-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('automatic diagnostics', () => {
  it('is enabled with no custom commands by default', () => {
    expect(configSchema.parse({}).diagnostics).toEqual({ autoRun: true, commands: [] })
  })

  it('detects supported package scripts with the declared package manager', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.0.0',
        scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run' },
      }),
    )

    expect(await detectDiagnosticCommands(cwd)).toEqual([
      'pnpm run lint',
      'pnpm run typecheck',
      'pnpm run test',
    ])
  })

  it('uses explicit commands instead of project detection', async () => {
    await writeFile(path.join(cwd, 'Cargo.toml'), '[package]\nname = "demo"\n')
    expect(await detectDiagnosticCommands(cwd, [' custom check ', 'second'])).toEqual([
      'custom check',
      'second',
    ])
  })

  it('detects common non-JavaScript test commands', async () => {
    await Promise.all([
      writeFile(path.join(cwd, 'Cargo.toml'), ''),
      writeFile(path.join(cwd, 'go.mod'), 'module example.test/demo\n'),
      writeFile(path.join(cwd, 'pyproject.toml'), '[project]\nname = "demo"\n'),
      mkdir(path.join(cwd, 'src')),
    ])
    expect(await detectDiagnosticCommands(cwd)).toEqual([
      'cargo check',
      'cargo test',
      'go test ./...',
      'python -m pytest',
    ])
  })

  it('asks once, supports a session grant, and reports each result', async () => {
    const events: AgentEvent[] = []
    const requestPermission = vi.fn<AgentHooks['requestPermission']>().mockResolvedValue('always')
    const grantForSession = vi.fn()
    const permissions = permissionGate('ask', grantForSession)
    const hooks: AgentHooks = { onEvent: (event) => events.push(event), requestPermission }
    const execute = vi.fn(async (command: string) => ({
      content: command === 'test command' ? 'failed' : 'ok',
      isError: command === 'test command',
    }))

    const result = await runAutomaticDiagnostics({
      cwd,
      changedFiles: ['src/app.ts'],
      configuredCommands: ['typecheck command', 'test command'],
      permissions,
      hooks,
      signal: new AbortController().signal,
      execute,
    })

    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestPermission.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'diagnostics',
      allowAlways: true,
      display: { kind: 'list', items: ['typecheck command', 'test command'] },
    })
    expect(grantForSession).toHaveBeenCalledWith('diagnostics')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.failed).toEqual(['test command'])
    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2)
  })

  it('does not execute commands denied by permissions', async () => {
    const events: AgentEvent[] = []
    const hooks: AgentHooks = {
      onEvent: (event) => events.push(event),
      requestPermission: vi.fn(),
    }
    const execute = vi.fn(async () => ({ content: 'unexpected' }))
    const result = await runAutomaticDiagnostics({
      cwd,
      changedFiles: ['file.ts'],
      configuredCommands: ['npm test'],
      permissions: permissionGate('deny'),
      hooks,
      signal: new AbortController().signal,
      execute,
    })

    expect(result.skipped).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'warn' }))
  })
})

function permissionGate(
  decision: 'allow' | 'ask' | 'deny',
  grantForSession = vi.fn(),
): PermissionGate {
  return {
    decide: () => decision,
    grantForSession,
    denyReason: () => undefined,
  }
}
