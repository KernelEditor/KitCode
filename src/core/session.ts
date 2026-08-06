import { randomBytes } from 'node:crypto'
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, sessionsDir } from '../config/paths'
import { redactSecrets } from '../providers/errors'
import type { ContentBlock, Message, Usage } from '../providers/types'
import type { ContextUsage, SessionState, UsageEntry } from './types'

const MAX_SESSION_BYTES = 50_000_000

export interface SessionSummary {
  id: string
  title?: string
  cwd: string
  model: string
  updatedAt: string
  messageCount: number
}

export interface DeleteAllSessionsResult {
  deleted: string[]
  failed: Array<{ id: string; error: string }>
}

export function createSession(cwd: string, model: string): SessionState {
  const now = new Date().toISOString()
  const stamp = now.replace(/[:.]/g, '-')
  return {
    id: `${stamp}-${randomBytes(3).toString('hex')}`,
    cwd,
    createdAt: now,
    updatedAt: now,
    model,
    messages: [],
    usage: [],
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  assertSessionId(state.id)
  state.updatedAt = new Date().toISOString()
  await ensureDir(sessionsDir)
  const file = path.join(sessionsDir, `${state.id}.json`)
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  await atomicRename(temp, file)
}

async function atomicRename(from: string, to: string, retries = 5): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw error
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
  await rename(from, to)
}

export async function loadSession(id: string): Promise<SessionState> {
  assertSessionId(id)
  const file = path.join(sessionsDir, `${id}.json`)
  let raw: string
  try {
    const info = await stat(file)
    if (info.size > MAX_SESSION_BYTES) {
      throw new Error(`Session exceeds the ${MAX_SESSION_BYTES / 1_000_000} MB load limit: ${file}`)
    }
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Session exceeds')) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No session found at ${file}`)
    }
    throw new Error(`Could not read session ${file}: ${(error as Error).message}`)
  }
  const state = readState(raw)
  if (!state) throw new Error(`Session file is not readable as a session: ${file}`)
  return state
}

export async function listSessions(limit = 20): Promise<SessionSummary[]> {
  const files = await filesByRecency()
  const summaries: SessionSummary[] = []
  for (const file of files.slice(0, limit)) {
    const state = readState(await readFile(file, 'utf8').catch(() => ''))
    if (state) {
      summaries.push({
        id: state.id,
        title: state.title,
        cwd: state.cwd,
        model: state.model,
        updatedAt: state.updatedAt,
        messageCount: state.messages.length,
      })
    }
  }
  return summaries
}

export async function renameSession(query: string, title: string): Promise<SessionState> {
  const id = await resolveSessionId(query)
  const trimmed = title.trim().replace(/[\r\n\0-\x1f\x7f]+/g, ' ').slice(0, 120)
  if (!trimmed) throw new Error('Give the session a non-empty title.')
  const state = await loadSession(id)
  state.title = trimmed
  await saveSession(state)
  return state
}

export async function deleteSession(query: string): Promise<string> {
  const id = await resolveSessionId(query)
  assertSessionId(id)
  await unlink(path.join(sessionsDir, `${id}.json`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`Session no longer exists: ${id}`)
    throw error
  })
  return id
}

export async function deleteAllSessions(): Promise<DeleteAllSessionsResult> {
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: [], failed: [] }
    throw error
  }

  const ids = names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    const id = name.slice(0, -'.json'.length)
    try {
      assertSessionId(id)
      return [id]
    } catch {
      return []
    }
  })
  const results = await Promise.allSettled(
    ids.map((id) => unlink(path.join(sessionsDir, `${id}.json`))),
  )
  const deleted: string[] = []
  const failed: DeleteAllSessionsResult['failed'] = []
  for (const [index, result] of results.entries()) {
    const id = ids[index] as string
    if (result.status === 'fulfilled' || (result.reason as NodeJS.ErrnoException)?.code === 'ENOENT') {
      deleted.push(id)
    } else {
      failed.push({
        id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  }
  return { deleted, failed }
}

export async function exportSession(
  query: string,
  destination: string,
): Promise<{ id: string; path: string }> {
  const id = await resolveSessionId(query)
  const state = await loadSession(id)
  const target = await resolveExportTarget(destination, state)
  await writeFile(target, renderSessionMarkdown(state), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      throw new Error(`Export already exists; choose another path: ${target}`)
    }
    throw error
  })
  return { id, path: target }
}

export async function latestSessionFor(cwd: string): Promise<SessionState | null> {
  for (const file of await filesByRecency()) {
    const state = readState(await readFile(file, 'utf8').catch(() => ''))
    if (state?.cwd === cwd) return state
  }
  return null
}

export function sanitizeHistory(messages: Message[]): Message[] {
  const resolved = new Set<string>()
  const out: Message[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const content = message.content.filter(
      (block) => block.type !== 'tool_use' || resolved.has(block.id),
    )
    for (const block of message.content) {
      if (block.type === 'tool_result') resolved.add(block.toolUseId)
    }
    if (content.length === 0) continue
    out.push(content.length === message.content.length ? message : { ...message, content })
  }
  return out.reverse()
}

async function filesByRecency(): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch {
    return []
  }
  const dated = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = path.join(sessionsDir, name)
        const info = await stat(file).catch(() => null)
        return { file, at: info?.mtimeMs ?? 0, size: info?.size ?? 0 }
      }),
  )
  return dated
    .filter((entry) => entry.size <= MAX_SESSION_BYTES)
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.file)
}

function readState(raw: string): SessionState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const state = parsed as Partial<SessionState>
  if (typeof state.id !== 'string' || !Array.isArray(state.messages)) return null
  return {
    id: state.id,
    title: typeof state.title === 'string' ? state.title.slice(0, 120) : undefined,
    cwd: typeof state.cwd === 'string' ? state.cwd : '',
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : '',
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    model: typeof state.model === 'string' ? state.model : '',
    messages: state.messages as Message[],
    usage: Array.isArray(state.usage) ? (state.usage as UsageEntry[]) : [],
    context: readContextUsage(state.context),
  }
}

async function resolveExportTarget(destination: string, state: SessionState): Promise<string> {
  const resolved = path.resolve(destination)
  const info = await stat(resolved).catch(() => null)
  if (info?.isDirectory()) {
    return path.join(resolved, exportFileName(state))
  }
  if (info) throw new Error(`Export destination is not a directory: ${resolved}`)
  const parent = await stat(path.dirname(resolved)).catch(() => null)
  if (!parent?.isDirectory()) throw new Error(`Export directory does not exist: ${path.dirname(resolved)}`)
  return resolved
}

function exportFileName(state: SessionState): string {
  const title = state.title
    ?.toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `kitcode-session-${title || shortSessionId(state.id)}.md`
}

function renderSessionMarkdown(state: SessionState): string {
  const lines = [
    `# ${state.title || `KitCode session ${shortSessionId(state.id)}`}`,
    '',
    `- Session: ${state.id}`,
    `- Workspace: ${state.cwd}`,
    `- Model: ${state.model || 'unknown'}`,
    `- Updated: ${state.updatedAt}`,
    '',
  ]
  for (const message of state.messages) {
    const rendered = renderMessage(message.content)
    if (!rendered) continue
    lines.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '', rendered, '')
  }
  return `${redactSecrets(lines.join('\n')).trimEnd()}\n`
}

function renderMessage(content: ContentBlock[]): string {
  const sections: string[] = []
  for (const block of content) {
    if (block.type === 'text') sections.push(block.text)
    else if (block.type === 'image') sections.push(`[Image attached: ${block.name}]`)
    else if (block.type === 'file') sections.push(`[File attached: ${block.name}]\n\n${block.text}`)
    else if (block.type === 'tool_use') sections.push(`> Tool: ${block.name}`)
    else if (block.type === 'tool_result') {
      sections.push(`> Tool result${block.isError ? ' (error)' : ''}:\n> ${block.content.replace(/\n/g, '\n> ')}`)
    }
    
  }
  return sections.join('\n\n').trim()
}

function readContextUsage(value: unknown): ContextUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { model?: unknown; usage?: unknown }
  if (typeof candidate.model !== 'string') return undefined
  const usage = readUsage(candidate.usage)
  return usage ? { model: candidate.model, usage } : undefined
}

function readUsage(value: unknown): Usage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const usage = value as Partial<Record<keyof Usage, unknown>>
  const fields: Array<keyof Usage> = ['input', 'output', 'cacheWrite', 'cacheRead']
  if (fields.some((field) => typeof usage[field] !== 'number' || !Number.isFinite(usage[field]))) {
    return undefined
  }
  return {
    input: usage.input as number,
    output: usage.output as number,
    cacheWrite: usage.cacheWrite as number,
    cacheRead: usage.cacheRead as number,
  }
}

export function shortSessionId(id: string): string {
  const dash = id.lastIndexOf('-')
  return dash === -1 ? id : id.slice(dash + 1)
}

export async function resolveSessionId(query: string): Promise<string> {
  const trimmed = query.trim()
  if (trimmed === '') throw new Error('Give a session id. List them with: kitcode sessions')

  const summaries = await listSessions(200)
  const exact = summaries.find((entry) => entry.id === trimmed)
  if (exact) return exact.id

  const matches = summaries.filter((entry) => entry.id.includes(trimmed))
  if (matches.length === 1) return (matches[0] as SessionSummary).id
  if (matches.length === 0) {
    throw new Error(`No session matches "${trimmed}". List them with: kitcode sessions`)
  }
  throw new Error(
    `"${trimmed}" matches ${matches.length} sessions. Be more specific:\n` +
      matches
        .slice(0, 5)
        .map((entry) => `  ${shortSessionId(entry.id)}  ${entry.updatedAt}  ${entry.cwd}`)
        .join('\n'),
  )
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,240}$/.test(id)) {
    throw new Error(`Invalid session id: ${id}`)
  }
}
