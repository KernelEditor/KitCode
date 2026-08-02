import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const home = await mkdtemp(path.join(tmpdir(), 'freecode-cfg-home-'))
process.env.FREECODE_HOME = home
delete process.env.FREECODE_CONFIG

const { authPath, configPath, resolveConfigLocation } = await import('../src/config/paths')
const { configLocation, loadConfig, saveAuth, saveConfig } = await import('../src/config/store')

const workspace = await mkdtemp(path.join(tmpdir(), 'freecode-cfg-ws-'))
const bare = await mkdtemp(path.join(tmpdir(), 'freecode-cfg-bare-'))
const nested = path.join(workspace, 'packages', 'app', 'src')
const projectFile = path.join(workspace, 'kitcode.json')

await mkdir(nested, { recursive: true })
await writeFile(projectFile, `${JSON.stringify({ version: 1, effort: 'low' }, null, 2)}\n`, 'utf8')

afterEach(() => {
  delete process.env.FREECODE_CONFIG
})

afterAll(async () => {
  await Promise.all(
    [home, workspace, bare].map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('resolveConfigLocation', () => {
  it('walks up from a nested subdirectory to the project config', async () => {
    expect(await resolveConfigLocation(nested)).toEqual({ path: projectFile, scope: 'project' })
  })

  it('lets FREECODE_CONFIG win over a project file', async () => {
    const override = path.join(home, 'explicit.json')
    process.env.FREECODE_CONFIG = override

    expect(await resolveConfigLocation(nested)).toEqual({ path: override, scope: 'env' })
  })

  it('falls back to the global config under FREECODE_HOME', async () => {
    const location = await resolveConfigLocation(bare)

    expect(location).toEqual({ path: configPath, scope: 'global' })
    expect(location.path.startsWith(home)).toBe(true)
  })
})

describe('loadConfig', () => {
  it('names the offending file when it fails to parse', async () => {
    const broken = path.join(bare, 'kitcode.json')
    await writeFile(broken, '{ "effort": "turbo" }', 'utf8')

    await expect(loadConfig(bare)).rejects.toThrow(broken)
    await rm(broken)
  })
})

describe('saveConfig', () => {
  it('writes back to the project file it loaded from', async () => {
    const config = await loadConfig(nested)
    expect(config.effort).toBe('low')

    config.model = 'demo/model-x'
    await saveConfig(config)

    expect(await configLocation()).toEqual({ path: projectFile, scope: 'project' })
    expect(JSON.parse(await readFile(projectFile, 'utf8')).model).toBe('demo/model-x')
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('saveAuth', () => {
  it('stays in the global home at mode 0600 while the config is project-local', async () => {
    await loadConfig(nested)
    await saveAuth({ demo: 'sk-secret' })

    expect(authPath.startsWith(home)).toBe(true)
    expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    await expect(stat(path.join(workspace, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('legacy name', () => {
  it('still finds a freecode.json left over from the old name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kitcode-legacy-'))
    await writeFile(path.join(dir, 'freecode.json'), JSON.stringify({ version: 1 }))
    const { resolveConfigLocation } = await import('../src/config/paths')
    const found = await resolveConfigLocation(dir)
    expect(found.scope).toBe('project')
    expect(found.path).toBe(path.join(dir, 'freecode.json'))
  })
})
