import { chmod, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, promptsDir } from '../config/paths'

export interface SavedPrompt {
  slug: string
  name: string
  description: string
  created: string
  body: string
}

export async function savePrompt(input: {
  name: string
  description?: string
  body: string
}): Promise<SavedPrompt> {
  const slug = slugify(input.name)
  if (!slug) throw new Error(`Prompt name has no letters or digits to name a file after: ${input.name}`)
  const prompt: SavedPrompt = {
    slug,
    name: input.name,
    description: input.description ?? '',
    created: new Date().toISOString(),
    body: input.body.trim(),
  }
  await ensureDir(promptsDir)
  const file = path.join(promptsDir, `${slug}.md`)
  await writeFile(file, serialize(prompt), {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmod(file, 0o600)
  return prompt
}

export async function getPrompt(slug: string): Promise<SavedPrompt | null> {
  assertSlug(slug)
  try {
    return parse(slug, await readFile(path.join(promptsDir, `${slug}.md`), 'utf8'))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  let names: string[]
  try {
    names = await readdir(promptsDir)
  } catch (error) {
    if (!isMissing(error)) throw error
    return []
  }
  const prompts = await Promise.all(
    names
      .filter((name) => name.endsWith('.md'))
      .map(async (name) =>
        parse(name.slice(0, -3), await readFile(path.join(promptsDir, name), 'utf8')),
      ),
  )
  return prompts.sort((a, b) => a.name.localeCompare(b.name))
}

export async function deletePrompt(slug: string): Promise<boolean> {
  assertSlug(slug)
  try {
    await unlink(path.join(promptsDir, `${slug}.md`))
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function searchPrompts(query: string): Promise<SavedPrompt[]> {
  const needle = query.trim().toLowerCase()
  const prompts = await listPrompts()
  if (!needle) return prompts
  return prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(needle) ||
      prompt.description.toLowerCase().includes(needle),
  )
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid prompt id: ${slug}`)
  }
}

function serialize(prompt: SavedPrompt): string {
  const field = (key: string, value: string) => `${key}: ${value.replace(/\s+/g, ' ').trim()}`
  return [
    '---',
    field('name', prompt.name),
    field('description', prompt.description),
    field('created', prompt.created),
    '---',
    '',
    prompt.body,
    '',
  ].join('\n')
}

function parse(slug: string, text: string): SavedPrompt {
  const lines = text.split('\n')
  const meta: Record<string, string> = {}
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    let i = 1
    for (; i < lines.length && lines[i].trim() !== '---'; i++) {
      const colon = lines[i].indexOf(':')
      if (colon <= 0) continue
      const key = lines[i].slice(0, colon).trim()
      if (key === 'name' || key === 'description' || key === 'created') {
        meta[key] = lines[i].slice(colon + 1).trim()
      }
    }
    bodyStart = Math.min(i + 1, lines.length)
  }
  return {
    slug,
    name: meta.name || slug,
    description: meta.description ?? '',
    created: meta.created ?? '',
    body: lines.slice(bodyStart).join('\n').trim(),
  }
}
