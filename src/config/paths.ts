import { chmod, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const explicitHome = process.env.KITCODE_HOME

export const homeDir = explicitHome || path.join(os.homedir(), '.kitcode')

export const configPath = path.join(homeDir, 'config.json')

export const authPath = path.join(homeDir, 'auth.json')

export const trustPath = path.join(homeDir, 'trusted-workspaces.json')

export const promptsDir = path.join(homeDir, 'prompts')

export const sessionsDir = path.join(homeDir, 'sessions')

export const checkpointsDir = path.join(homeDir, 'checkpoints')

export const cacheDir = path.join(homeDir, 'cache')

export const skillsDir = path.join(homeDir, 'skills')

export function projectSkillsDir(dir: string): string {
  return path.join(dir, '.kitcode', 'skills')
}

const projectConfigName = 'kitcode.json'

export type ConfigScope = 'env' | 'project' | 'global'

export interface ConfigLocation {
  path: string
  scope: ConfigScope
}

export function projectConfigPath(dir: string): string {
  return path.join(path.resolve(dir), projectConfigName)
}

async function findProjectConfig(from: string): Promise<string | undefined> {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, projectConfigName)
    if (await isFile(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export async function resolveConfigLocation(cwd: string = process.cwd()): Promise<ConfigLocation> {
  const override = process.env.KITCODE_CONFIG
  if (override) return { path: path.resolve(override), scope: 'env' }

  const project = await findProjectConfig(cwd)
  if (project) return { path: project, scope: 'project' }

  return { path: configPath, scope: 'global' }
}

export async function workspaceRootFor(cwd: string = process.cwd()): Promise<string> {
  const project = await findProjectConfig(cwd)
  return project ? path.dirname(project) : path.resolve(cwd)
}

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
  await chmod(dir, mode)
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
