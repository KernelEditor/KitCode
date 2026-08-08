import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import type { ConfigLocation } from './paths'
import {
  authPath,
  configPath,
  ensureDir,
  homeDir,
  projectConfigPath,
  resolveConfigLocation,
} from './paths'
import type { AuthFile, Config, ProviderConfig } from './schema'
import { authSchema, configSchema, defaultConfig } from './schema'
import { isWorkspaceTrusted } from './trust'

let active: ConfigLocation | undefined

export async function configLocation(): Promise<ConfigLocation> {
  active ??= await resolveConfigLocation()
  return active
}

export async function loadConfig(cwd?: string): Promise<Config> {
  const location = await resolveConfigLocation(cwd)
  return loadConfigAt(location)
}

export async function loadProjectConfig(dir: string): Promise<Config> {
  return loadConfigAt({ path: projectConfigPath(dir), scope: 'project' })
}

export interface RuntimeConfigLoad {
  config: Config
  ignoredProject?: ConfigLocation
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigLoad> {
  const location = await resolveConfigLocation(cwd)
  if (location.scope === 'project' && !(await isWorkspaceTrusted(cwd))) {
    const ignoredProject = location
    const config = await loadConfigAt({ path: configPath, scope: 'global' })
    return { config, ignoredProject }
  }
  return { config: await loadConfigAt(location) }
}

async function loadConfigAt(location: ConfigLocation): Promise<Config> {
  active = location
  const raw = await readJson(location.path)
  if (raw === undefined) return defaultConfig()
  const result = configSchema.safeParse(raw)
  if (!result.success) throw new Error(formatIssues(location.path, result.error))
  return result.data
}

export async function saveConfig(config: Config): Promise<void> {
  const location = await configLocation()
  await writeJsonAtomic(location.path, config, location.scope === 'project' ? undefined : 0o600)
}

export async function initProjectConfig(dir: string): Promise<ConfigLocation> {
  const location: ConfigLocation = { path: projectConfigPath(dir), scope: 'project' }
  if ((await readJson(location.path)) === undefined) {
    await writeJsonAtomic(location.path, defaultConfig())
  }
  return location
}

export async function loadAuth(): Promise<AuthFile> {
  await hardenPrivateHome()
  const raw = await readJson(authPath)
  if (raw === undefined) return {}
  await chmod(authPath, 0o600)
  const result = authSchema.safeParse(raw)
  if (!result.success) throw new Error(formatIssues(authPath, result.error))
  return result.data
}

export async function saveAuth(auth: AuthFile): Promise<void> {
  await writeJsonAtomic(authPath, auth, 0o600)
}

async function hardenPrivateHome(): Promise<void> {
  try {
    await chmod(homeDir, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function resolveApiKey(
  providerId: string,
  providerConfig: ProviderConfig,
  auth: AuthFile = {},
): string | undefined {
  const candidates = [
    providerConfig.keyEnv ? process.env[providerConfig.keyEnv] : undefined,
    process.env[conventionalKeyEnv(providerId)],
    auth[providerId],
    providerConfig.type === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined,
  ]
  return candidates.find((value) => value !== undefined && value !== '')
}

export function conventionalKeyEnv(providerId: string): string {
  return `KITCODE_${providerId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_KEY`
}

export function expandEnvRefs(value: string): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? '')
}

export function expandEnvRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expandEnvRefs(value)]),
  )
}

async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
}

async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  const parent = path.dirname(file)
  if (isInside(homeDir, parent)) await ensureDir(parent)
  else await mkdir(parent, { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    await rename(temp, file)
    if (mode !== undefined) await chmod(file, mode)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..')
}

function formatIssues(file: string, error: z.ZodError): string {
  const lines = error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
  return [`${file} is invalid:`, ...lines].join('\n')
}
