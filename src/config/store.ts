import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, cp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import type { ConfigLocation } from './paths'
import {
  authPath,
  configPath,
  ensureDir,
  homeDir,
  homeOverridden,
  legacyHomeDir,
  projectConfigPath,
  resolveConfigLocation,
} from './paths'
import type { AuthFile, Config, ProviderConfig } from './schema'
import { authSchema, configSchema, defaultConfig } from './schema'
import { isWorkspaceTrusted } from './trust'

let active: ConfigLocation | undefined

export interface HomeMigration {
  migrated: boolean
  from?: string
  to?: string
}

let homeMigration: Promise<HomeMigration> | undefined

export function migrateLegacyHome(): Promise<HomeMigration> {
  homeMigration ??= copyLegacyHome()
  return homeMigration
}

async function copyLegacyHome(): Promise<HomeMigration> {
  if (homeOverridden) {
    return { migrated: false }
  }
  if (existsSync(homeDir)) {
    await hardenDefaultHome()
    return { migrated: false }
  }
  if (!existsSync(legacyHomeDir)) return { migrated: false }
  await cp(legacyHomeDir, homeDir, { recursive: true })
  await hardenDefaultHome()
  return { migrated: true, from: legacyHomeDir, to: homeDir }
}

async function hardenDefaultHome(): Promise<void> {
  await chmod(homeDir, 0o700)
  try {
    await chmod(authPath, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function configLocation(): Promise<ConfigLocation> {
  active ??= await resolveConfigLocation()
  return active
}

export async function loadConfig(cwd?: string): Promise<Config> {
  await migrateLegacyHome()
  const location = await resolveConfigLocation(cwd)
  return loadConfigAt(location)
}

export async function loadProjectConfig(dir: string): Promise<Config> {
  await migrateLegacyHome()
  return loadConfigAt({ path: projectConfigPath(dir), scope: 'project' })
}

export interface RuntimeConfigLoad {
  config: Config
  ignoredProject?: ConfigLocation
}

/** Load executable project settings only after the workspace was explicitly trusted. */
export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigLoad> {
  await migrateLegacyHome()
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
  await migrateLegacyHome()
  const location = await configLocation()
  await writeJsonAtomic(location.path, config)
}

export async function initProjectConfig(dir: string): Promise<ConfigLocation> {
  const location: ConfigLocation = { path: projectConfigPath(dir), scope: 'project' }
  if ((await readJson(location.path)) === undefined) {
    await writeJsonAtomic(location.path, defaultConfig())
  }
  return location
}

export async function loadAuth(): Promise<AuthFile> {
  await migrateLegacyHome()
  const raw = await readJson(authPath)
  if (raw === undefined) return {}
  await chmod(authPath, 0o600)
  const result = authSchema.safeParse(raw)
  if (!result.success) throw new Error(formatIssues(authPath, result.error))
  return result.data
}

export async function saveAuth(auth: AuthFile): Promise<void> {
  await migrateLegacyHome()
  await writeJsonAtomic(authPath, auth, 0o600)
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
  await ensureDir(path.dirname(file))
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

function formatIssues(file: string, error: z.ZodError): string {
  const lines = error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
  return [`${file} is invalid:`, ...lines].join('\n')
}
