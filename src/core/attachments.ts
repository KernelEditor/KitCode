import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ContentBlock, FileBlock, ImageBlock } from '../providers/types'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024

export interface LoadedAttachment {
  block: ImageBlock | FileBlock
  bytes: number
  path: string
}

export async function loadAttachment(cwd: string, requestedPath: string): Promise<LoadedAttachment> {
  const cleaned = normalizeInputPath(requestedPath.trim())
  if (!cleaned) throw new Error('Give a file path: /attach <path>')
  const expanded = cleaned === '~' ? os.homedir() : cleaned.startsWith('~/') ? path.join(os.homedir(), cleaned.slice(2)) : cleaned
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)
  const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Attachment not found: ${resolved}`)
    throw error
  })
  if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${resolved}`)

  const name = safeName(path.basename(resolved))
  const imageLimitCandidate = info.size <= MAX_IMAGE_BYTES
  if (!imageLimitCandidate) {
    throw new Error(`Attachment is larger than ${formatBytes(MAX_IMAGE_BYTES)}: ${name}`)
  }
  const data = await readFile(resolved)
  const mediaType = detectImage(data)
  if (mediaType) {
    return {
      path: resolved,
      bytes: data.length,
      block: { type: 'image', mediaType, data: data.toString('base64'), name },
    }
  }

  if (data.length > MAX_TEXT_BYTES) {
    throw new Error(`Text attachment is larger than ${formatBytes(MAX_TEXT_BYTES)}: ${name}`)
  }
  if (data.includes(0)) throw new Error(`Unsupported binary attachment: ${name}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new Error(`Attachment is neither a supported image nor UTF-8 text: ${name}`)
  }
  return {
    path: resolved,
    bytes: data.length,
    block: { type: 'file', mediaType: textMime(resolved), text, name },
  }
}

export function attachmentLabel(block: ContentBlock): string | null {
  if (block.type === 'image') return `image: ${block.name}`
  if (block.type === 'file') return `file: ${block.name}`
  return null
}

function detectImage(data: Buffer): ImageBlock['mediaType'] | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  const prefix = data.subarray(0, 6).toString('ascii')
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif'
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function textMime(file: string): string {
  const extension = path.extname(file).toLowerCase()
  const known: Record<string, string> = {
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.csv': 'text/csv',
  }
  return known[extension] ?? 'text/plain'
}

function normalizeInputPath(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  // Paths dragged into a terminal commonly escape spaces and punctuation.
  return value.replace(/\\([\\ "'()\[\]{}&;#$!])/g, (_match, character: string) => character)
}

function safeName(value: string): string {
  return value.replace(/[\r\n\0-\x1f\x7f]/g, '').slice(0, 200) || 'attachment'
}

function formatBytes(value: number): string {
  return `${Math.round(value / 1024 / 1024)} MB`
}
