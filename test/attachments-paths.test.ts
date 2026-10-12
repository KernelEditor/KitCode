import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SENT_IMAGE_BYTES, fitImage, loadAttachment, splitAttachmentPaths } from '../src/core/attachments'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_000)])

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('several files at once', () => {
  it('splits quoted and plain absolute paths into separate attachments', () => {
    expect(splitAttachmentPaths(String.raw`"C:\a b\1.png" "C:\c\2.png"`)).toEqual([String.raw`C:\a b\1.png`, String.raw`C:\c\2.png`])
    expect(splitAttachmentPaths(String.raw`C:\a\1.png C:\a\2.png`)).toEqual([String.raw`C:\a\1.png`, String.raw`C:\a\2.png`])
    expect(splitAttachmentPaths('/tmp/a.png /tmp/b\\ c.png')).toEqual(['/tmp/a.png', '/tmp/b\\ c.png'])
    expect(splitAttachmentPaths("'/tmp/a b.png' file:///tmp/c.png")).toEqual(['/tmp/a b.png', 'file:///tmp/c.png'])
  })

  it('leaves single paths and sentences alone', () => {
    expect(splitAttachmentPaths(String.raw`C:\a\1.png`)).toBeNull()
    expect(splitAttachmentPaths('look at /tmp/a.png please')).toBeNull()
    expect(splitAttachmentPaths('src/a.ts src/b.ts')).toBeNull()
  })
})

describe('windows paths', () => {
  it('keeps separators before ( [ # $ and UNC prefixes intact', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kitcode-att-'))
    const nested = path.join(dir, '[work]')
    await mkdir(nested)
    const file = path.join(nested, 'note.md')
    await writeFile(file, 'hello')
    if (process.platform === 'win32') {
      const loaded = await loadAttachment(process.cwd(), file)
      expect(loaded.path).toBe(file)
    }
    await expect(loadAttachment(process.cwd(), String.raw`\\no-such-server\share\x.png`)).rejects.toThrow(String.raw`\\no-such-server`)
  })
})

describe('oversized images', () => {
  it('passes small images through untouched', async () => {
    const small = Buffer.concat([PNG_HEADER, Buffer.alloc(10)])
    const fitted = await fitImage(small, 'image/png', 'linux', async () => { throw new Error('should not run') })
    expect(fitted).toEqual({ data: small, mediaType: 'image/png' })
  })

  it('scales big images down to a JPEG under the API limit', async () => {
    const big = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_SENT_IMAGE_BYTES)])
    const fitted = await fitImage(big, 'image/png', 'win32', async (_input, output) => writeFile(output, JPEG))
    expect(fitted.mediaType).toBe('image/jpeg')
    expect(fitted.data.length).toBe(JPEG.length)
  })

  it('explains what to do when no image tool is available', async () => {
    const big = Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_SENT_IMAGE_BYTES)])
    await expect(fitImage(big, 'image/png', 'linux', async () => { throw new Error('ENOENT') }))
      .rejects.toThrow('install ImageMagick')
  })
})
