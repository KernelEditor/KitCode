import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const isWindows = process.platform === 'win32'

const home = await mkdtemp(path.join(tmpdir(), 'kitcode-cfg-home-'))
process.env.KITCODE_HOME = home
delete process.env.KITCODE_CONFIG

const { authPath, configPath, homeDir, resolveConfigLocation, trustPath } = await import('../src/config/paths')
const { configLocation, loadConfig, loadProjectConfig, loadRuntimeConfig, saveAuth, saveConfig } = await import('../src/config/store')
const { isWorkspaceTrusted, revokeWorkspaceTrust, trustWorkspace } = await import('../src/config/trust')

const workspace = await mkdtemp(path.join(tmpdir(), 'kitcode-cfg-ws-'))
const bare = await mkdtemp(path.join(tmpdir(), 'kitcode-cfg-bare-'))
const nested = path.join(workspace, 'packages', 'app', 'src')
const projectFile = path.join(workspace, 'kitcode.json')

await mkdir(nested, { recursive: true })
await writeFile(projectFile, `${JSON.stringify({ version: 1, effort: 'low' }, null, 2)}\n`, 'utf8')

afterEach(() => {
  delete process.env.KITCODE_CONFIG
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

  it('lets KITCODE_CONFIG win over a project file', async () => {
    const override = path.join(home, 'explicit.json')
    process.env.KITCODE_CONFIG = override

    expect(await resolveConfigLocation(nested)).toEqual({ path: override, scope: 'env' })
  })

  it('falls back to the global config under KITCODE_HOME', async () => {
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

  it('can explicitly load a project config even when an env override is present', async () => {
    process.env.KITCODE_CONFIG = path.join(home, 'explicit.json')
    const config = await loadProjectConfig(workspace)
    expect(config.effort).toBe('low')
    expect(await configLocation()).toEqual({ path: projectFile, scope: 'project' })
  })
})

describe('workspace trust', () => {
  it('ignores executable project settings until the project root is trusted', async () => {
    await revokeWorkspaceTrust(nested)
    const untrusted = await loadRuntimeConfig(nested)
    expect(untrusted.ignoredProject?.path).toBe(projectFile)
    expect(untrusted.config.effort).toBe('xhigh')

    const trustedRoot = await trustWorkspace(nested)
    expect(trustedRoot).toBe(await realpath(workspace))
    expect(await isWorkspaceTrusted(workspace)).toBe(true)
    expect((await loadRuntimeConfig(nested)).config.effort).toBe('low')
    if (!isWindows) {
      expect((await stat(trustPath)).mode & 0o777).toBe(0o600)
    }

    await revokeWorkspaceTrust(workspace)
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
    if (!isWindows) {
      expect((await stat(authPath)).mode & 0o777).toBe(0o600)
      expect((await stat(homeDir)).mode & 0o777).toBe(0o700)
    }
    await expect(stat(path.join(workspace, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
