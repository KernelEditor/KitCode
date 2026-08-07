import { execFile } from 'node:child_process'
import { lstat, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentBlock, FileBlock, ImageBlock } from '../providers/types'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const MAX_CLIPBOARD_OUTPUT_BYTES = MAX_IMAGE_BYTES + 64 * 1024

const AUTO_PATH_NAMES = new Set(['dockerfile', 'license', 'makefile', 'readme'])
const SENSITIVE_AUTO_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  'auth.json',
  'credentials.json',
  'id_dsa',
  'id_ed25519',
  'id_ecdsa',
  'id_rsa',
  'kitcode.json',
  'secret.json',
  'secrets.json',
  'tokens.json',
  'kubeconfig',
  'service-account.json',
])
const SENSITIVE_AUTO_EXTENSIONS = new Set(['.jks', '.key', '.keystore', '.p12', '.pem', '.pfx', '.p8', '.der'])

export interface LoadedAttachment {
  block: ImageBlock | FileBlock
  bytes: number
  path: string
}

export type ClipboardCommandRunner = (command: string, args: string[]) => Promise<Buffer>

export async function loadAttachment(cwd: string, requestedPath: string): Promise<LoadedAttachment> {
  const resolved = resolveAttachmentPath(cwd, requestedPath)
  const linkInfo = await lstat(resolved).catch(() => null)
  if (linkInfo?.isSymbolicLink()) {
    throw new Error(`Cannot attach symbolic links: ${path.basename(resolved)}`)
  }
  const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Attachment not found: ${resolved}`)
    throw error
  })
  if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${resolved}`)

  return loadResolvedAttachment(resolved, info.size)
}

export async function loadAutomaticAttachment(
  cwd: string,
  requestedPath: string,
): Promise<LoadedAttachment | null> {
  if (!looksLikeAttachmentPath(requestedPath)) return null
  const resolved = resolveAttachmentPath(cwd, requestedPath)
  // Check sensitive files first — they always require explicit /attach
  if (isSensitiveAutomaticPath(resolved)) {
    throw new Error(
      `For safety, sensitive-looking files must be attached explicitly with /attach: ${path.basename(resolved)}`,
    )
  }
  // Block absolute paths that point outside common project areas for auto-attachments
  if (path.isAbsolute(resolved)) {
    const normalized = resolved.toLowerCase()
    const isProjectFile =
      normalized.includes(path.sep + 'src' + path.sep) ||
      normalized.includes(path.sep + 'lib' + path.sep) ||
      normalized.includes(path.sep + 'app' + path.sep) ||
      normalized.includes(path.sep + 'test' + path.sep) ||
      normalized.includes(path.sep + 'tests' + path.sep) ||
      normalized.includes(path.sep + 'public' + path.sep) ||
      normalized.includes(path.sep + 'assets' + path.sep) ||
      normalized.includes(path.sep + 'static' + path.sep) ||
      normalized.endsWith('.ts') ||
      normalized.endsWith('.js') ||
      normalized.endsWith('.tsx') ||
      normalized.endsWith('.jsx') ||
      normalized.endsWith('.py') ||
      normalized.endsWith('.go') ||
      normalized.endsWith('.rs') ||
      normalized.endsWith('.java') ||
      normalized.endsWith('.c') ||
      normalized.endsWith('.cpp') ||
      normalized.endsWith('.h') ||
      normalized.endsWith('.hpp') ||
      normalized.endsWith('.css') ||
      normalized.endsWith('.html') ||
      normalized.endsWith('.json') ||
      normalized.endsWith('.yaml') ||
      normalized.endsWith('.yml') ||
      normalized.endsWith('.md') ||
      normalized.endsWith('.txt') ||
      normalized.endsWith('.toml') ||
      normalized.endsWith('.ini') ||
      normalized.endsWith('.cfg') ||
      normalized.endsWith('.sh') ||
      normalized.endsWith('.bat') ||
      normalized.endsWith('.cmd') ||
      normalized.endsWith('.ps1') ||
      normalized.endsWith('.dockerfile') ||
      normalized.endsWith('.makefile')
    if (!isProjectFile) return null
  }
  const linkInfo = await lstat(resolved).catch(() => null)
  if (linkInfo?.isSymbolicLink()) return null
  const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (!info?.isFile()) return null
  return loadResolvedAttachment(resolved, info.size)
}

export function looksLikeAttachmentPath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return false
  const candidate = normalizeInputPath(trimmed)
  if (/^file:\/\//i.test(candidate)) return true
  if (path.isAbsolute(candidate)) return true
  if (/^(?:~|\.{1,2})[\\/]/.test(candidate)) return true
  if (candidate.includes('/') || candidate.includes('\\')) return true
  const basename = path.basename(candidate).toLowerCase()
  return path.extname(basename) !== '' || AUTO_PATH_NAMES.has(basename)
}

export async function loadClipboardImage(
  platform: NodeJS.Platform = process.platform,
  runner: ClipboardCommandRunner = runClipboardCommand,
): Promise<ImageBlock> {
  const commands = clipboardCommands(platform)
  if (commands.length === 0) {
    throw new Error(`Clipboard image paste is not supported on ${platform}. Use /attach <path>.`)
  }

  for (const command of commands) {
    try {
      const data = await runner(command.file, command.args)
      if (data.length === 0) continue
      const mediaType = detectImage(data)
      if (!mediaType) continue
      if (data.length > MAX_IMAGE_BYTES) {
        throw new Error(`Clipboard image is larger than ${formatBytes(MAX_IMAGE_BYTES)}.`)
      }
      return {
        type: 'image',
        mediaType,
        data: data.toString('base64'),
        name: clipboardImageName(mediaType),
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Clipboard image is larger')) {
        throw error
      }
    }
  }

  const hint =
    platform === 'linux'
      ? 'Copy an image first; Linux requires wl-paste or xclip.'
      : 'Copy an image first, then press Ctrl+V or Cmd+V again.'
  throw new Error(`No supported image found in the clipboard. ${hint}`)
}

async function loadResolvedAttachment(resolved: string, size: number): Promise<LoadedAttachment> {

  const name = safeName(path.basename(resolved))
  const imageLimitCandidate = size <= MAX_IMAGE_BYTES
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

function resolveAttachmentPath(cwd: string, requestedPath: string): string {
  const cleaned = normalizeInputPath(requestedPath.trim())
  if (!cleaned) throw new Error('Give a file path: /attach <path>')
  if (/^file:\/\//i.test(cleaned)) {
    try {
      return path.normalize(fileURLToPath(cleaned))
    } catch {
      throw new Error(`Invalid local file URL: ${cleaned}`)
    }
  }
  const expanded =
    cleaned === '~'
      ? os.homedir()
      : cleaned.startsWith('~/')
        ? path.join(os.homedir(), cleaned.slice(2))
        : cleaned
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded)
}

function isSensitiveAutomaticPath(file: string): boolean {
  const basename = path.basename(file).toLowerCase()
  return (
    basename.startsWith('.env.') ||
    SENSITIVE_AUTO_NAMES.has(basename) ||
    SENSITIVE_AUTO_EXTENSIONS.has(path.extname(basename))
  )
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

function clipboardImageName(mediaType: ImageBlock['mediaType']): string {
  if (mediaType === 'image/jpeg') return 'clipboard.jpg'
  if (mediaType === 'image/gif') return 'clipboard.gif'
  if (mediaType === 'image/webp') return 'clipboard.webp'
  return 'clipboard.png'
}

function clipboardCommands(platform: NodeJS.Platform): Array<{ file: string; args: string[] }> {
  if (platform === 'darwin') {
    return [{ file: 'osascript', args: ['-l', 'JavaScript', '-e', MACOS_CLIPBOARD_SCRIPT] }]
  }
  if (platform === 'win32') {
    return [
      {
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', WINDOWS_CLIPBOARD_SCRIPT],
      },
    ]
  }
  if (platform === 'linux') {
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    return [
      ...types.map((type) => ({ file: 'wl-paste', args: ['--no-newline', '--type', type] })),
      ...types.map((type) => ({
        file: 'xclip',
        args: ['-selection', 'clipboard', '-t', type, '-o'],
      })),
    ]
  }
  return []
}

function runClipboardCommand(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: null,
        maxBuffer: MAX_CLIPBOARD_OUTPUT_BYTES,
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
  })
}

const MACOS_CLIPBOARD_SCRIPT = String.raw`
ObjC.import('AppKit')
ObjC.import('Foundation')

function present(value) {
  return value !== null && value !== undefined && ObjC.unwrap(value) !== undefined
}

function pngFromTiff(tiff) {
  if (!present(tiff)) return null
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff)
  if (!present(bitmap)) return null
  return bitmap.representationUsingTypeProperties(
    $.NSBitmapImageFileTypePNG,
    $.NSDictionary.dictionary,
  )
}

const pasteboard = $.NSPasteboard.generalPasteboard
let data = null
const directTypes = [
  $.NSPasteboardTypePNG,
  $('public.jpeg'),
  $('com.compuserve.gif'),
  $('public.webp'),
  $('org.webmproject.webp'),
]
for (const type of directTypes) {
  const candidate = pasteboard.dataForType(type)
  if (present(candidate)) {
    data = candidate
    break
  }
}

if (!present(data)) data = pngFromTiff(pasteboard.dataForType($.NSPasteboardTypeTIFF))

if (!present(data)) {
  const fileUrl = pasteboard.stringForType($.NSPasteboardTypeFileURL)
  if (present(fileUrl)) {
    const image = $.NSImage.alloc.initWithContentsOfURL($.NSURL.URLWithString(fileUrl))
    if (present(image)) data = pngFromTiff(image.TIFFRepresentation)
  }
}

if (!present(data)) {
  const files = pasteboard.propertyListForType($.NSFilenamesPboardType)
  if (present(files) && ObjC.unwrap(files.count) > 0) {
    const image = $.NSImage.alloc.initWithContentsOfURL(
      $.NSURL.fileURLWithPath(files.objectAtIndex(0)),
    )
    if (present(image)) {
      data = pngFromTiff(image.TIFFRepresentation)
    }
  }
}

if (!present(data)) throw new Error('no clipboard image')
$.NSFileHandle.fileHandleWithStandardOutput.writeData(data)
`

const WINDOWS_CLIPBOARD_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) { exit 2 }
$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`

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
  return value.replace(/\\([\\ "'()\[\]&;#$!])/g, (_match, character: string) => character)
}

function safeName(value: string): string {
  return value.replace(/[\r\n\0-\x1f\x7f]/g, '').slice(0, 200) || 'attachment'
}

function formatBytes(value: number): string {
  return `${Math.round(value / 1024 / 1024)} MB`
}
