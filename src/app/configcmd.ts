import { authPath, projectConfigPath } from '../config/paths'
import {
  configLocation,
  initProjectConfig,
  loadProjectConfig,
  loadRuntimeConfig,
  migrateLegacyHome,
  saveConfig,
} from '../config/store'
import { trustWorkspace } from '../config/trust'

export async function showConfig(options: { local?: boolean } = {}): Promise<void> {
  const migration = await migrateLegacyHome()
  const cwd = process.cwd()
  if (migration.migrated) {
    console.log(`migrated ${migration.from} -> ${migration.to} (old copy left in place)`)
  }

  if (options.local) {
    const current = (await loadRuntimeConfig(cwd)).config
    await initProjectConfig(cwd)
    await trustWorkspace(cwd)
    await loadProjectConfig(cwd)
    await saveConfig(current)
    console.log(`moved config to ${projectConfigPath(cwd)}`)
  }

  if (!options.local) await loadRuntimeConfig(cwd)

  const location = await configLocation()
  console.log(`config: ${location.path}  (${location.scope})`)
  console.log(`keys:   ${authPath}  (never written into a project)`)
}
