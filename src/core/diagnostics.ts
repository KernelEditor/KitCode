import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { bashTool } from '../tools/bash'
import { brief } from '../tools/summary'
import type { Tool, ToolContext, ToolResult } from '../tools/types'
import type { PermissionGate } from './agent'
import type { AgentHooks } from './types'

const MAX_PACKAGE_BYTES = 1_000_000
const DIAGNOSTIC_TIMEOUT_MS = 300_000

const diagnosticsTool: Tool = {
  name: 'diagnostics',
  description: 'Run detected project checks after file edits.',
  inputSchema: { type: 'object' },
  defaultPermission: 'ask',
  summarize: () => 'automatic project checks',
  execute: async () => ({ content: '' }),
}

export interface DiagnosticsSummary {
  commands: string[]
  failed: string[]
  skipped: boolean
}

export async function detectDiagnosticCommands(
  cwd: string,
  configured: string[] = [],
): Promise<string[]> {
  const custom = configured.map((command) => command.trim()).filter(Boolean)
  if (custom.length > 0) return custom.slice(0, 8)

  const commands: string[] = []
  const packageJson = await readPackageJson(path.join(cwd, 'package.json'))
  if (packageJson) {
    const manager = await packageManager(cwd, packageJson.packageManager)
    for (const name of ['lint', 'typecheck', 'check', 'test']) {
      if (typeof packageJson.scripts?.[name] === 'string') {
        commands.push(scriptCommand(manager, name))
      }
    }
  }

  if (await isFile(path.join(cwd, 'Cargo.toml'))) {
    commands.push('cargo check', 'cargo test')
  }
  if (await isFile(path.join(cwd, 'go.mod'))) commands.push('go test ./...')
  if (
    (await isFile(path.join(cwd, 'pyproject.toml'))) ||
    (await isFile(path.join(cwd, 'pytest.ini'))) ||
    (await isFile(path.join(cwd, 'tox.ini')))
  ) {
    commands.push('python -m pytest')
  }

  return [...new Set(commands)].slice(0, 8)
}

export async function runAutomaticDiagnostics(options: {
  cwd: string
  changedFiles: string[]
  configuredCommands?: string[]
  permissions: PermissionGate
  hooks: AgentHooks
  signal: AbortSignal
  execute?: (command: string, ctx: ToolContext) => Promise<ToolResult>
}): Promise<DiagnosticsSummary> {
  const commands = await detectDiagnosticCommands(options.cwd, options.configuredCommands)
  const summary: DiagnosticsSummary = { commands, failed: [], skipped: false }
  if (options.changedFiles.length === 0 || commands.length === 0 || options.signal.aborted) {
    summary.skipped = true
    return summary
  }

  const gate = options.permissions.decide(diagnosticsTool)
  if (gate === 'deny') {
    summary.skipped = true
    options.hooks.onEvent({
      type: 'notice',
      level: 'warn',
      text: 'Automatic project checks were skipped by the current permission settings.',
    })
    return summary
  }

  if (gate === 'ask') {
    const decision = await options.hooks.requestPermission({
      toolName: diagnosticsTool.name,
      summary: `run ${commands.length} automatic project ${commands.length === 1 ? 'check' : 'checks'}`,
      input: { commands, changedFiles: options.changedFiles },
      display: {
        kind: 'list',
        title: `After changes to ${options.changedFiles.length} ${options.changedFiles.length === 1 ? 'file' : 'files'}`,
        items: commands,
      },
      allowAlways: true,
    })
    if (options.signal.aborted) {
      summary.skipped = true
      return summary
    }
    if (decision === 'deny') {
      summary.skipped = true
      options.hooks.onEvent({
        type: 'notice',
        level: 'warn',
        text: 'Automatic project checks were skipped.',
      })
      return summary
    }
    if (decision === 'always') options.permissions.grantForSession(diagnosticsTool.name)
  }

  const ctx: ToolContext = {
    cwd: options.cwd,
    signal: options.signal,
    confirm: async () => true,
    requestPermission: options.hooks.requestPermission,
  }
  const execute = options.execute ?? ((command, context) =>
    bashTool.execute({ command, timeoutMs: DIAGNOSTIC_TIMEOUT_MS }, context))

  for (const [index, command] of commands.entries()) {
    if (options.signal.aborted) {
      summary.skipped = true
      break
    }
    const id = `diagnostics-${Date.now()}-${index}`
    const callSummary = `check · ${brief(command, 160)}`
    options.hooks.onEvent({ type: 'tool_start', id, name: diagnosticsTool.name, summary: callSummary })
    try {
      const result = await execute(command, ctx)
      if (result.isError) summary.failed.push(command)
      options.hooks.onEvent({
        type: 'tool_end',
        id,
        isError: result.isError === true,
        content: result.content,
        display: result.display,
      })
    } catch (error) {
      summary.failed.push(command)
      options.hooks.onEvent({
        type: 'tool_end',
        id,
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return summary
}

interface PackageJson {
  packageManager?: string
  scripts?: Record<string, unknown>
}

async function readPackageJson(file: string): Promise<PackageJson | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_PACKAGE_BYTES) return null
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const candidate = value as PackageJson
    return {
      packageManager:
        typeof candidate.packageManager === 'string' ? candidate.packageManager : undefined,
      scripts:
        typeof candidate.scripts === 'object' && candidate.scripts !== null
          ? candidate.scripts
          : undefined,
    }
  } catch {
    return null
  }
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

async function packageManager(cwd: string, declared?: string): Promise<PackageManager> {
  const name = declared?.split('@')[0]
  if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name
  if (await isFile(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await isFile(path.join(cwd, 'yarn.lock'))) return 'yarn'
  if (
    (await isFile(path.join(cwd, 'bun.lock'))) ||
    (await isFile(path.join(cwd, 'bun.lockb')))
  ) {
    return 'bun'
  }
  return 'npm'
}

function scriptCommand(manager: PackageManager, name: string): string {
  return manager === 'yarn' ? `yarn ${name}` : `${manager} run ${name}`
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
