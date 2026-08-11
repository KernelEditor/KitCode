import type { Stats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

export interface SkillMeta {
  name: string
  description: string
  dir: string
  file: string
}

export interface Skill extends SkillMeta {
  body: string
}

const SKILL_FILE = 'SKILL.md'
const FRONTMATTER_BYTES = 8192
const MAX_SKILL_BYTES = 5_000_000
const MAX_SKILLS_PER_ROOT = 500

interface SkillGuard {
  root: string
  rootIdentity: FileIdentity
  dirIdentity: FileIdentity
  fileIdentity: FileIdentity
}

interface FileIdentity {
  dev: number
  ino: number
}

const guards = new WeakMap<SkillMeta, SkillGuard>()

export async function discoverSkills(dirs: string[]): Promise<SkillMeta[]> {
  const byName = new Map<string, SkillMeta>()
  for (const root of dirs) {
    const rootInfo = await lstat(root).catch(() => null)
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) continue
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const found = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, MAX_SKILLS_PER_ROOT)
        .map((entry) => readMeta(root, rootInfo, path.join(root, entry.name))),
    )
    for (const meta of found) {
      if (meta && !byName.has(meta.name)) byName.set(meta.name, meta)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadSkill(meta: SkillMeta): Promise<Skill> {
  const guard = guards.get(meta)
  if (!guard) throw new Error(`Skill was not discovered through a protected skill root: ${meta.file}`)
  await assertIdentity(guard.root, guard.rootIdentity, 'skill root')
  await assertIdentity(meta.dir, guard.dirIdentity, 'skill directory')
  const opened = await openVerified(meta.file, guard.fileIdentity)
  if (opened.info.size > MAX_SKILL_BYTES) {
    await opened.handle.close()
    throw new Error(`Skill file exceeds the ${MAX_SKILL_BYTES / 1_000_000} MB limit: ${meta.file}`)
  }
  let text: string
  try {
    text = (await readBounded(opened.handle, MAX_SKILL_BYTES)).toString('utf8')
  } finally {
    await opened.handle.close()
  }
  await assertIdentity(guard.root, guard.rootIdentity, 'skill root')
  await assertIdentity(meta.dir, guard.dirIdentity, 'skill directory')
  await assertIdentity(meta.file, guard.fileIdentity, 'skill file')
  const { body } = parseFrontmatter(text)
  return { ...meta, body }
}

export function formatSkillCatalogue(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => `- ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`)
  return ['Skills available (use the skill tool to read one in full before doing that kind of work):', ...lines].join(
    '\n',
  )
}

async function readMeta(root: string, rootInfo: Stats, dir: string): Promise<SkillMeta | null> {
  const dirInfo = await lstat(dir).catch(() => null)
  if (!dirInfo?.isDirectory() || dirInfo.isSymbolicLink()) return null
  const file = path.join(dir, SKILL_FILE)
  const head = await readFrontmatterBytes(file)
  if (!head) return null
  const { fields } = parseFrontmatter(head.text)
  const meta = { name: fields.name || path.basename(dir), description: fields.description ?? '', dir, file }
  guards.set(meta, {
    root,
    rootIdentity: identity(rootInfo),
    dirIdentity: identity(dirInfo),
    fileIdentity: head.identity,
  })
  return meta
}

async function readFrontmatterBytes(
  file: string,
): Promise<{ text: string; identity: FileIdentity } | null> {
  const before = await lstat(file).catch(() => null)
  if (!before?.isFile() || before.isSymbolicLink()) return null
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(opened, identity(before))) return null
    const buffer = Buffer.alloc(FRONTMATTER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_BYTES, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), identity: identity(opened) }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

async function openVerified(
  file: string,
  expected: FileIdentity,
): Promise<{ handle: FileHandle; info: Stats }> {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(before, expected)) {
    throw new Error(`Refusing changed or symlinked skill file: ${file}`)
  }
  const handle = await open(file, 'r')
  const info = await handle.stat()
  if (!info.isFile() || !sameIdentity(info, expected)) {
    await handle.close()
    throw new Error(`Refusing skill file changed while opening: ${file}`)
  }
  return { handle, info }
}

async function assertIdentity(file: string, expected: FileIdentity, label: string): Promise<void> {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !sameIdentity(info, expected)) {
    throw new Error(`Refusing changed or symlinked ${label}: ${file}`)
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const remaining = maxBytes + 1 - total
    if (remaining <= 0) throw new Error(`Skill file exceeds the ${maxBytes / 1_000_000} MB limit`)
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) return Buffer.concat(chunks, total)
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
  }
}

function identity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino }
}

function sameIdentity(info: Stats, expected: FileIdentity): boolean {
  return info.dev === expected.dev && info.ino === expected.ino
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split('\n')
  const fields: Record<string, string> = {}
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    let i = 1
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const colon = lines[i].indexOf(':')
      if (colon <= 0) continue
      const key = lines[i].slice(0, colon).trim()
      if (key === 'name' || key === 'description') fields[key] = lines[i].slice(colon + 1).trim()
    }
    bodyStart = Math.min(i + 1, lines.length)
  }
  return { fields, body: lines.slice(bodyStart).join('\n').trim() }
}
