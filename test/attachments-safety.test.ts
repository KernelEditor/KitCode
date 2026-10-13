import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fitImage,
  imageSize,
  loadAttachment,
  loadMentionAttachment,
  withoutImages,
} from '../src/core/attachments'
import { imageRejection } from '../src/app/runtime'
import { ProviderError } from '../src/providers/types'
import type { Message } from '../src/providers/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kitcode-attach-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

describe('@ mentions', () => {
  it('attaches a workspace file', async () => {
    await writeFile(path.join(dir, 'notes.md'), '# notes')
    const loaded = await loadMentionAttachment(dir, 'notes.md')
    expect(loaded?.block).toMatchObject({ type: 'file', name: 'notes.md', text: '# notes' })
  })

  it('never sends credentials, however the mention is written', async () => {
    await writeFile(path.join(dir, '.env'), 'API_KEY=secret')
    await mkdir(path.join(dir, '.ssh'))
    await writeFile(path.join(dir, '.ssh', 'config'), 'Host x')
    await writeFile(path.join(dir, 'server.key'), 'key')
    for (const mention of ['.env', './.env', '.ssh/config', 'server.key']) {
      await expect(loadMentionAttachment(dir, mention)).rejects.toThrow(/attached explicitly/)
    }
  })

  it('ignores paths outside the workspace and folders', async () => {
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`)
    await writeFile(outside, 'private')
    try {
      expect(await loadMentionAttachment(dir, outside)).toBeNull()
      expect(await loadMentionAttachment(dir, `../${path.basename(outside)}`)).toBeNull()
      expect(await loadMentionAttachment(dir, '~/.bashrc')).toBeNull()
    } finally {
      await rm(outside, { force: true })
    }
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'shot.png'), png(10, 10))
    expect(await loadMentionAttachment(dir, 'src')).toBeNull()
  })
})

describe('attachment formats', () => {
  it('reads UTF-16 text as written by Notepad or PowerShell', async () => {
    const text = 'Привет, логи'
    await writeFile(path.join(dir, 'le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const loaded = await loadAttachment(dir, 'le.txt')
    expect(loaded.block).toMatchObject({ type: 'file', text })
  })

  it('picks a sendable image from a folder even when a .bmp sorts first', async () => {
    await writeFile(path.join(dir, 'a.bmp'), Buffer.from('BM fake bitmap'))
    await writeFile(path.join(dir, 'b.png'), png(10, 10))
    const loaded = await loadAttachment(dir, '.')
    expect(loaded.block).toMatchObject({ type: 'image', name: 'b.png' })
  })

  it('reads the pixel size of every supported format', () => {
    expect(imageSize(png(1200, 12000), 'image/png')).toEqual({ width: 1200, height: 12000 })
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1')
    expect(imageSize(gif, 'image/gif')).toEqual({ width: 320, height: 240 })
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
    ])
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 800, height: 600 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp.writeUIntLE(1919, 24, 3)
    webp.writeUIntLE(1079, 27, 3)
    expect(imageSize(webp, 'image/webp')).toEqual({ width: 1920, height: 1080 })
  })

  it('scales down a small file whose edge is over the API limit', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
    let shrunk = false
    const fitted = await fitImage(png(1200, 12000), 'image/png', 'win32', async (_input, output) => {
      shrunk = true
      await writeFile(output, jpeg)
    })
    expect(shrunk).toBe(true)
    expect(fitted.mediaType).toBe('image/jpeg')
  })
})

describe('a refused image', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAAA' }] },
  ]

  it('is replaced by a note so the conversation can go on', () => {
    const refused = new ProviderError('"deepseek" rejected the request (400) — image input is not supported', 'deepseek', 400)
    const recovered = imageRejection(refused, history)
    expect(recovered?.removed).toBe(1)
    expect(recovered?.messages[0]?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('shot.png removed') })
  })

  it('also recognises a refusal sent inside a 200 stream, without a status', () => {
    const refused = new ProviderError('Request to "gw" failed — image_url is not supported for this model', 'gw')
    expect(imageRejection(refused, history)?.removed).toBe(1)
  })

  it('leaves the history alone for unrelated failures', () => {
    expect(imageRejection(new ProviderError('rate limited (429)', 'x', 429), history)).toBeNull()
    expect(imageRejection(new ProviderError('rejected (400) — max_tokens too large', 'x', 400), history)).toBeNull()
    expect(imageRejection(new ProviderError('too large (413)', 'x', 413), [])).toBeNull()
    expect(withoutImages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]).removed).toBe(0)
  })
})
