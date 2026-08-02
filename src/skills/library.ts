import { open, readFile, readdir } from 'node:fs/promises'
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

export async function discoverSkills(dirs: string[]): Promise<SkillMeta[]> {
  const byName = new Map<string, SkillMeta>()
  for (const root of dirs) {
    const entries = await readdir(root).catch(() => [])
    const found = await Promise.all(entries.map((entry) => readMeta(path.join(root, entry))))
    for (const meta of found) {
      if (meta && !byName.has(meta.name)) byName.set(meta.name, meta)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadSkill(meta: SkillMeta): Promise<Skill> {
  const { body } = parseFrontmatter(await readFile(meta.file, 'utf8'))
  return { ...meta, body }
}

export function formatSkillCatalogue(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => `- ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`)
  return ['Skills available (use the skill tool to read one in full before doing that kind of work):', ...lines].join(
    '\n',
  )
}

async function readMeta(dir: string): Promise<SkillMeta | null> {
  const file = path.join(dir, SKILL_FILE)
  const head = await readFrontmatterBytes(file)
  if (head === null) return null
  const { fields } = parseFrontmatter(head)
  return { name: fields.name || path.basename(dir), description: fields.description ?? '', dir, file }
}

async function readFrontmatterBytes(file: string): Promise<string | null> {
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(FRONTMATTER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
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
