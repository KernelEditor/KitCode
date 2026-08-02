import { randomBytes } from 'node:crypto'
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, sessionsDir } from '../config/paths'
import type { Message, Usage } from '../providers/types'
import type { ContextUsage, SessionState, UsageEntry } from './types'

export interface SessionSummary {
  id: string
  cwd: string
  model: string
  updatedAt: string
  messageCount: number
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
  state.updatedAt = new Date().toISOString()
  await ensureDir(sessionsDir)
  const file = path.join(sessionsDir, `${state.id}.json`)
  // A random suffix keeps concurrent writes for the same session from sharing
  // the temp path and clobbering each other's rename.
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  // Sessions can contain large tool outputs; compact JSON cuts serialization
  // and disk work on the hot path immediately after a turn finishes.
  await writeFile(temp, JSON.stringify(state), 'utf8')
  await rename(temp, file)
}

export async function loadSession(id: string): Promise<SessionState> {
  const file = path.join(sessionsDir, `${id}.json`)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new Error(`No session found at ${file}`)
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
        cwd: state.cwd,
        model: state.model,
        updatedAt: state.updatedAt,
        messageCount: state.messages.length,
      })
    }
  }
  return summaries
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
        return { file, at: info?.mtimeMs ?? 0 }
      }),
  )
  return dated.sort((a, b) => b.at - a.at).map((entry) => entry.file)
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
    cwd: typeof state.cwd === 'string' ? state.cwd : '',
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : '',
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    model: typeof state.model === 'string' ? state.model : '',
    messages: state.messages as Message[],
    usage: Array.isArray(state.usage) ? (state.usage as UsageEntry[]) : [],
    context: readContextUsage(state.context),
  }
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
