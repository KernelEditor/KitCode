import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cacheDir, ensureDir } from '../config/paths'
import type { ModelInfo, Provider } from './types'

const MAX_AGE_MS = 24 * 60 * 60 * 1000
const CACHE_VERSION = 2

interface ModelCache {
  version?: number
  fetchedAt: number
  models: ModelInfo[]
}

export async function loadModels(provider: Provider, refresh = false): Promise<ModelInfo[]> {
  const file = cacheFile(provider.id)
  const cached = await readCache(file)
  if (
    !refresh &&
    cached?.version === CACHE_VERSION &&
    Date.now() - cached.fetchedAt < MAX_AGE_MS
  ) {
    return cached.models
  }

  let models: ModelInfo[]
  try {
    models = await provider.listModels()
  } catch (error) {
    if (cached) return cached.models
    const known = provider.knownModels()
    if (known.length > 0) return known
    throw error
  }

  await writeCache(file, models)
  return models
}

export function refreshModels(provider: Provider): Promise<ModelInfo[]> {
  return loadModels(provider, true)
}

function cacheFile(providerId: string): string {
  return path.join(cacheDir, 'models', `${providerId.replace(/[^\w.-]/g, '_')}.json`)
}

async function readCache(file: string): Promise<ModelCache | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ModelCache
  } catch {
    return undefined
  }
}

async function writeCache(file: string, models: ModelInfo[]): Promise<void> {
  const payload: ModelCache = { version: CACHE_VERSION, fetchedAt: Date.now(), models }
  try {
    await ensureDir(path.dirname(file))
    await writeFile(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    await chmod(file, 0o600)
  } catch {
    return
  }
}
