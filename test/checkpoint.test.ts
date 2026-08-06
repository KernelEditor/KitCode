import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beginCheckpoint, undoLatestCheckpoint } from '../src/core/checkpoint'

const isWindows = process.platform === 'win32'

let root: string
let cwd: string
let storageDir: string
const sessionId = 'checkpoint-test-session'

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kitcode-checkpoint-'))
  cwd = path.join(root, 'workspace')
  storageDir = path.join(root, 'state', 'checkpoints')
  await mkdir(cwd)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('automatic file checkpoints', () => {
  it('restores original bytes and file mode', async () => {
    const file = path.join(cwd, 'src.txt')
    await writeFile(file, 'before\n')
    await chmod(file, 0o640)

    const checkpoint = beginCheckpoint({ cwd, sessionId, storageDir })
    await checkpoint.capture(file)
    await writeFile(file, 'after\n')
    await chmod(file, 0o600)
    checkpoint.markChanged(file)
    const committed = await checkpoint.commit()

    expect(committed?.paths).toEqual(['src.txt'])
    const checkpointFile = path.join(storageDir, sessionId, `${committed?.id}.json`)
    if (!isWindows) {
      expect((await stat(checkpointFile)).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(checkpointFile))).mode & 0o777).toBe(0o700)
    }

    const result = await undoLatestCheckpoint({ cwd, sessionId, storageDir })
    expect(result).toMatchObject({ found: true, restored: ['src.txt'], conflicts: [], failed: [] })
    expect(await readFile(file, 'utf8')).toBe('before\n')
    if (!isWindows) {
      expect((await stat(file)).mode & 0o777).toBe(0o640)
    }
  })

  it('removes a file created by the agent', async () => {
    const file = path.join(cwd, 'created.txt')
    const checkpoint = beginCheckpoint({ cwd, sessionId, storageDir })
    await checkpoint.capture(file)
    await writeFile(file, 'new\n')
    checkpoint.markChanged(file)
    await checkpoint.commit()

    const result = await undoLatestCheckpoint({ cwd, sessionId, storageDir })
    expect(result.removed).toEqual(['created.txt'])
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('undoes multiple turns in stack order', async () => {
    const file = path.join(cwd, 'stack.txt')
    await writeFile(file, 'one')

    const first = beginCheckpoint({ cwd, sessionId, storageDir })
    await first.capture(file)
    await writeFile(file, 'two')
    first.markChanged(file)
    await first.commit()

    const second = beginCheckpoint({ cwd, sessionId, storageDir })
    await second.capture(file)
    await writeFile(file, 'three')
    second.markChanged(file)
    await second.commit()

    await undoLatestCheckpoint({ cwd, sessionId, storageDir })
    expect(await readFile(file, 'utf8')).toBe('two')
    await undoLatestCheckpoint({ cwd, sessionId, storageDir })
    expect(await readFile(file, 'utf8')).toBe('one')
  })

  it('preserves a newer manual edit instead of overwriting it', async () => {
    const file = path.join(cwd, 'conflict.txt')
    await writeFile(file, 'original')
    const checkpoint = beginCheckpoint({ cwd, sessionId, storageDir })
    await checkpoint.capture(file)
    await writeFile(file, 'agent edit')
    checkpoint.markChanged(file)
    await checkpoint.commit()
    await writeFile(file, 'manual edit')

    const result = await undoLatestCheckpoint({ cwd, sessionId, storageDir })
    expect(result.conflicts).toEqual(['conflict.txt'])
    expect(await readFile(file, 'utf8')).toBe('manual edit')
    expect(await undoLatestCheckpoint({ cwd, sessionId, storageDir })).toMatchObject({ found: false })
  })

  it('does not store a checkpoint when the final file matches its original bytes', async () => {
    const file = path.join(cwd, 'same.txt')
    await writeFile(file, 'same')
    const checkpoint = beginCheckpoint({ cwd, sessionId, storageDir })
    await checkpoint.capture(file)
    await writeFile(file, 'temporary')
    await writeFile(file, 'same')
    checkpoint.markChanged(file)

    expect(await checkpoint.commit()).toBeNull()
    expect(await undoLatestCheckpoint({ cwd, sessionId, storageDir })).toMatchObject({ found: false })
  })
})
