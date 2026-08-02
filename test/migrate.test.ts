import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const realHome = process.env.HOME
const scratches: string[] = []

afterAll(async () => {
  process.env.HOME = realHome
  await Promise.all(scratches.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kitcode-migrate-'))
  scratches.push(dir)
  return dir
}

async function seedLegacy(home: string): Promise<string> {
  const legacy = path.join(home, '.freecode')
  await mkdir(path.join(legacy, 'sessions'), { recursive: true })
  await writeFile(path.join(legacy, 'config.json'), JSON.stringify({ version: 1, model: 'old/one' }))
  await writeFile(path.join(legacy, 'auth.json'), JSON.stringify({ old: 'sk-legacy' }))
  await chmod(path.join(legacy, 'auth.json'), 0o600)
  return legacy
}

async function freshStore(home: string, env: Record<string, string> = {}) {
  process.env.HOME = home
  delete process.env.KITCODE_HOME
  delete process.env.FREECODE_HOME
  delete process.env.KITCODE_CONFIG
  delete process.env.FREECODE_CONFIG
  Object.assign(process.env, env)
  vi.resetModules()
  return await import('../src/config/store')
}

describe('migrateLegacyHome', () => {
  it('copies a legacy home into ~/.kitcode on first load and keeps the original', async () => {
    const home = await scratch()
    const legacy = await seedLegacy(home)
    const store = await freshStore(home)

    expect((await store.loadConfig(await scratch())).model).toBe('old/one')
    expect(await store.loadAuth()).toEqual({ old: 'sk-legacy' })
    expect(await store.migrateLegacyHome()).toEqual({
      migrated: true,
      from: legacy,
      to: path.join(home, '.kitcode'),
    })

    const copiedAuth = path.join(home, '.kitcode', 'auth.json')
    expect((await stat(copiedAuth)).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(home, '.kitcode', 'sessions'))).isDirectory()).toBe(true)
    expect((await stat(path.join(legacy, 'config.json'))).isFile()).toBe(true)
    expect((await stat(path.join(legacy, 'auth.json'))).mode & 0o777).toBe(0o600)
  })

  it('leaves an existing ~/.kitcode config untouched', async () => {
    const home = await scratch()
    await seedLegacy(home)
    const current = path.join(home, '.kitcode', 'config.json')
    await mkdir(path.join(home, '.kitcode'), { recursive: true })
    await writeFile(current, JSON.stringify({ version: 1, model: 'new/one' }))

    const store = await freshStore(home)

    expect((await store.loadConfig(await scratch())).model).toBe('new/one')
    expect(await store.migrateLegacyHome()).toEqual({ migrated: false })
    expect(JSON.parse(await readFile(current, 'utf8')).model).toBe('new/one')
  })

  for (const variable of ['KITCODE_HOME', 'FREECODE_HOME']) {
    it(`does nothing when ${variable} is set`, async () => {
      const home = await scratch()
      await seedLegacy(home)
      const override = await scratch()
      const store = await freshStore(home, { [variable]: override })

      expect(await store.loadConfig(await scratch())).toMatchObject({ version: 1 })
      expect(await store.migrateLegacyHome()).toEqual({ migrated: false })
      await expect(stat(path.join(home, '.kitcode'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  }

  it('is idempotent', async () => {
    const home = await scratch()
    await seedLegacy(home)
    const store = await freshStore(home)
    const copied = path.join(home, '.kitcode', 'config.json')

    expect((await store.migrateLegacyHome()).migrated).toBe(true)
    await writeFile(copied, JSON.stringify({ version: 1, model: 'edited/after' }))

    expect(await store.migrateLegacyHome()).toEqual(await store.migrateLegacyHome())
    const restarted = await freshStore(home)
    expect(await restarted.migrateLegacyHome()).toEqual({ migrated: false })
    expect(JSON.parse(await readFile(copied, 'utf8')).model).toBe('edited/after')
  })
})
