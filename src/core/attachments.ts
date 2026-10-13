import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContentBlock, FileBlock, ImageBlock, Message } from '../providers/types'
import { resolveInside } from '../tools/safepath'
import { isSensitivePath } from '../tools/sensitive'

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
  if (info.isDirectory()) {
    const attachment = await loadFirstImageFromDirectory(resolved)
    if (attachment) return attachment
    throw new Error(`No supported images found in directory: ${path.basename(resolved)}`)
  }
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
  const linkInfo = await lstat(resolved).catch(() => null)
  if (linkInfo?.isSymbolicLink()) return null
  const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (info?.isDirectory()) return loadFirstImageFromDirectory(resolved)
  if (!info?.isFile()) return null
  return loadResolvedAttachment(resolved, info.size)
}

/**
 * A file named with "@path" inside a message. Unlike /attach this happens
 * without a separate step, and a pasted text can carry the "@" too, so it is
 * held to the agent's own read rules: workspace files only, credentials never.
 * Null means "not a file to attach" and the word stays plain text.
 */
export async function loadMentionAttachment(
  cwd: string,
  requestedPath: string,
): Promise<LoadedAttachment | null> {
  const safe = resolveInside(cwd, normalizeInputPath(requestedPath.trim()))
  if (!safe.ok || safe.relative === '') return null
  if (isSensitivePath(safe.relative) || isSensitiveAutomaticPath(safe.path)) {
    throw new Error(
      `For safety, sensitive-looking files must be attached explicitly with /attach: ${path.basename(safe.path)}`,
    )
  }
  const info = await stat(safe.path).catch(() => null)
  // A folder mention ("@src") names a place, not something to send.
  if (!info?.isFile()) return null
  return loadResolvedAttachment(safe.path, info.size)
}

/**
 * The history with every image replaced by a short note. Used when the model
 * refused an image: left in place, it would fail every later request too.
 */
export function withoutImages(messages: Message[]): { messages: Message[]; removed: number } {
  let removed = 0
  const cleaned = messages.map((message) => {
    if (!message.content.some((block) => block.type === 'image')) return message
    return {
      ...message,
      content: message.content.map((block): ContentBlock => {
        if (block.type !== 'image') return block
        removed += 1
        return { type: 'text', text: `[image ${block.name} removed: the model could not accept it]` }
      }),
    }
  })
  return { messages: cleaned, removed }
}

const MAX_PATH_CHARS = 2048

export function looksLikeAttachmentPath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return false
  if (trimmed.length > MAX_PATH_CHARS) return false
  const candidate = normalizeInputPath(trimmed)
  if (/^file:\/\//i.test(candidate)) return true
  if (path.isAbsolute(candidate)) return true
  if (/^(?:~|\.{1,2})[\\/]/.test(candidate)) return true
  // A path-like string embedded in a longer message (e.g. pasted terminal
  // output containing /Users/...) should not be treated as an attachment.
  // Only treat short relative paths with slashes as attachments; longer text
  // must start with a path prefix to qualify.
  if (candidate.includes('/') || candidate.includes('\\')) {
    // Long strings with slashes are likely pasted terminal output, not a path.
    if (trimmed.length > 200) return false
    return true
  }
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
      const fitted = await fitImage(data, mediaType, platform)
      return {
        type: 'image',
        mediaType: fitted.mediaType,
        data: fitted.data.toString('base64'),
        name: clipboardImageName(fitted.mediaType),
      }
    } catch (error) {
      if (error instanceof Error && /^(?:Clipboard image|Image) is larger/.test(error.message)) {
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
    const fitted = await fitImage(data, mediaType)
    return {
      path: resolved,
      bytes: fitted.data.length,
      block: { type: 'image', mediaType: fitted.mediaType, data: fitted.data.toString('base64'), name },
    }
  }

  if (data.length > MAX_TEXT_BYTES) {
    throw new Error(`Text attachment is larger than ${formatBytes(MAX_TEXT_BYTES)}: ${name}`)
  }
  const text = decodeText(data)
  if (text === null) {
    throw new Error(
      data.includes(0)
        ? `Unsupported binary attachment: ${name}`
        : `Attachment is neither a supported image nor UTF-8 text: ${name}`,
    )
  }
  return {
    path: resolved,
    bytes: data.length,
    block: { type: 'file', mediaType: textMime(resolved), text, name },
  }
}

async function loadFirstImageFromDirectory(dirPath: string): Promise<LoadedAttachment | null> {
  // Only formats detectImage accepts: a .bmp sorted first would otherwise
  // fail the whole directory even when PNGs sit right next to it.
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => null)
  if (!entries) return null
  const sorted = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (sorted.length === 0) return null
  const first = sorted[0]!
  const filePath = path.join(dirPath, first.name)
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) return null
  return loadResolvedAttachment(filePath, info.size)
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
    // Also covers ~/.ssh/config, ~/.aws/credentials, .git-credentials and the like.
    isSensitivePath(file) ||
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

// UTF-8, or UTF-16 with a byte order mark: what Notepad and PowerShell's ">"
// write on Windows. UTF-16 is full of zero bytes, so it has to be recognised
// before the binary check.
function decodeText(data: Buffer): string | null {
  try {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(data)
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(data)
    if (data.includes(0)) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return null
  }
}

/** Pixel size from the file header, without decoding the image. */
export function imageSize(data: Buffer, mediaType: ImageBlock['mediaType']): { width: number; height: number } | null {
  try {
    if (mediaType === 'image/png' && data.length >= 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    }
    if (mediaType === 'image/gif' && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
    }
    if (mediaType === 'image/webp' && data.length >= 30) {
      const chunk = data.subarray(12, 16).toString('ascii')
      if (chunk === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
      if (chunk === 'VP8L') {
        const bits = data.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
      return null
    }
    if (mediaType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) return null
        const marker = data[offset + 1] as number
        if (marker === 0xff) {
          offset += 1
          continue
        }
        // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        offset += 2 + data.readUInt16BE(offset + 2)
      }
    }
  } catch {
    return null
  }
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
if ($null -eq $image) {
  # An image file copied in Explorer arrives as a file list, not a bitmap.
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  $file = $files | Where-Object { $_ -match '\.(png|jpe?g|gif|webp)$' } | Select-Object -First 1
  if ($null -eq $file) { exit 2 }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
  exit 0
}
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

// Claude rejects images over 5 MB once base64-encoded (≈3.75 MB raw), and the
// failed image then stays in the history, breaking every later request.
// Bigger images (4K screenshots) are scaled down and re-encoded as JPEG.
export const MAX_SENT_IMAGE_BYTES = 3_700_000
// The API also refuses an image with an edge over 8000 px, however small the
// file: a full-page screenshot (1200×12000) is a few hundred KB and would
// break the conversation the same way.
const MAX_IMAGE_EDGE = 8000
const SHRINK_LONG_EDGE = 2000

export type ImageShrinker = (input: string, output: string, platform: NodeJS.Platform) => Promise<void>

export async function fitImage(
  data: Buffer,
  mediaType: ImageBlock['mediaType'],
  platform: NodeJS.Platform = process.platform,
  shrink: ImageShrinker = shrinkWithSystemTools,
): Promise<{ data: Buffer; mediaType: ImageBlock['mediaType'] }> {
  const size = imageSize(data, mediaType)
  const tooTall = size !== null && Math.max(size.width, size.height) > MAX_IMAGE_EDGE
  if (data.length <= MAX_SENT_IMAGE_BYTES && !tooTall) return { data, mediaType }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kitcode-image-'))
  try {
    const input = path.join(dir, `in${extensionFor(mediaType)}`)
    const output = path.join(dir, 'out.jpg')
    await writeFile(input, data)
    try {
      await shrink(input, output, platform)
    } catch {
      throw new Error(
        `Image is larger than ${formatBytes(MAX_SENT_IMAGE_BYTES)} and could not be scaled down automatically` +
          (platform === 'win32' || platform === 'darwin' ? '' : ' (install ImageMagick for that)') +
          '. Save a smaller copy and attach that.',
      )
    }
    const shrunk = await readFile(output)
    if (shrunk.length > MAX_SENT_IMAGE_BYTES || detectImage(shrunk) !== 'image/jpeg') {
      throw new Error(`Image is larger than ${formatBytes(MAX_SENT_IMAGE_BYTES)} even after scaling it down.`)
    }
    return { data: shrunk, mediaType: 'image/jpeg' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function shrinkWithSystemTools(input: string, output: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    await runQuiet('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SHRINK_SCRIPT], {
      KITCODE_IMAGE_IN: input,
      KITCODE_IMAGE_OUT: output,
      KITCODE_IMAGE_EDGE: String(SHRINK_LONG_EDGE),
    })
    return
  }
  if (platform === 'darwin') {
    await runQuiet('sips', ['-Z', String(SHRINK_LONG_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', input, '--out', output])
    return
  }
  // Linux and the rest: ImageMagick, as `magick` (v7) or `convert` (v6).
  // -auto-orient: a phone photo is stored sideways with an EXIF rotation flag
  // that the re-encoded JPEG would no longer carry.
  const args = [input, '-auto-orient', '-resize', `${SHRINK_LONG_EDGE}x${SHRINK_LONG_EDGE}>`, '-background', 'white', '-flatten', '-quality', '85', output]
  try {
    await runQuiet('magick', args)
  } catch {
    await runQuiet('convert', args)
  }
}

function runQuiet(command: string, args: string[], env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20_000, windowsHide: true, env: { ...process.env, ...env } }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function extensionFor(mediaType: ImageBlock['mediaType']): string {
  return mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/gif' ? '.gif' : mediaType === 'image/webp' ? '.webp' : '.png'
}

const WINDOWS_SHRINK_SCRIPT = String.raw`
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($env:KITCODE_IMAGE_IN)
try {
  # Apply the EXIF orientation: the re-encoded JPEG drops the flag that kept a
  # phone photo upright.
  if ($source.PropertyIdList -contains 0x0112) {
    $flip = @{ 2 = 'RotateNoneFlipX'; 3 = 'Rotate180FlipNone'; 4 = 'Rotate180FlipX'; 5 = 'Rotate90FlipX'; 6 = 'Rotate90FlipNone'; 7 = 'Rotate270FlipX'; 8 = 'Rotate270FlipNone' }[[int]$source.GetPropertyItem(0x0112).Value[0]]
    if ($flip) { $source.RotateFlip([System.Drawing.RotateFlipType]$flip) }
  }
  $edge = [double]$env:KITCODE_IMAGE_EDGE
  $scale = [Math]::Min(1.0, $edge / [Math]::Max($source.Width, $source.Height))
  $width = [Math]::Max(1, [int]($source.Width * $scale))
  $height = [Math]::Max(1, [int]($source.Height * $scale))
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawImage($source, 0, 0, $width, $height)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
  $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
  $bitmap.Save($env:KITCODE_IMAGE_OUT, $codec, $parameters)
  $graphics.Dispose()
  $bitmap.Dispose()
} finally {
  $source.Dispose()
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
  // Backslash escapes come from macOS/Linux shells. In a Windows path the
  // backslash is the separator: unescaping would turn \\server into \server
  // and C:\[work]\a.png into C:[work]\a.png. Only "\ " is still read as an
  // escaped space, since no Windows folder name starts with a space.
  if (WINDOWS_PATH.test(value)) return value.replace(/\\ /g, ' ')
  return value.replace(/\\([\\ "'()\[\]&;#$!])/g, (_match, character: string) => character)
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * Several files dropped or pasted at once arrive as one line, e.g.
 * `"C:\a b\1.png" "C:\c\2.png"` or `/tmp/a.png /tmp/b.png`. Returns the
 * separate paths, or null when the text is not such a list.
 */
export function splitAttachmentPaths(value: string): string[] | null {
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null
  const tokens: string[] = []
  const pattern = /"([^"]+)"|'([^']+)'|((?:\\ |[^\s"'])+)/g
  for (const match of trimmed.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  if (tokens.length < 2) return null
  // Only a list of absolute paths (or file:// URLs) counts: anything else is a
  // sentence that merely contains a path.
  const absolute = (token: string) =>
    /^file:\/\//i.test(token) || WINDOWS_PATH.test(token) || token.startsWith('/') || /^~[\\/]/.test(token)
  return tokens.every(absolute) ? tokens : null
}

function safeName(value: string): string {
  return value.replace(/[\r\n\0-\x1f\x7f]/g, '').slice(0, 200) || 'attachment'
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
}
