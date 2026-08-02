import { authPath, projectConfigPath } from '../config/paths'
import {
  configLocation,
  initProjectConfig,
  loadConfig,
  migrateLegacyHome,
  saveConfig,
} from '../config/store'

export async function showConfig(options: { local?: boolean } = {}): Promise<void> {
  const migration = await migrateLegacyHome()
  if (migration.migrated) {
    console.log(`migrated ${migration.from} -> ${migration.to} (old copy left in place)`)
  }

  if (options.local) {
    const current = await loadConfig()
    const cwd = process.cwd()
    await initProjectConfig(cwd)
    await loadConfig(cwd)
    await saveConfig(current)
    console.log(`moved config to ${projectConfigPath(cwd)}`)
  }

  const location = await configLocation()
  console.log(`config: ${location.path}  (${location.scope})`)
  console.log(`keys:   ${authPath}  (never written into a project)`)
}
