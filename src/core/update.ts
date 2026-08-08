import { KITCODE_COMMIT, KITCODE_REPOSITORY, KITCODE_VERSION } from '../version'

const UPDATE_URL = `https://api.github.com/repos/${KITCODE_REPOSITORY}/commits/main`
const TIMEOUT_MS = 4_000
const MAX_RESPONSE_BYTES = 128_000

export type UpdateCheck =
  | { status: 'current'; current: string; latest: string }
  | { status: 'available'; current: string; latest: string; url: string }
  | { status: 'unknown'; reason: string }

export async function checkForUpdates(
  fetcher: typeof fetch = fetch,
  currentCommit = KITCODE_COMMIT,
): Promise<UpdateCheck> {
  if (currentCommit === 'development') {
    return { status: 'unknown', reason: 'development build has no embedded commit' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetcher(UPDATE_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `KitCode/${KITCODE_VERSION}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { status: 'unknown', reason: `GitHub returned ${response.status}` }
    }
    const payload = (await readJsonBounded(response)) as { sha?: unknown; html_url?: unknown } | null
    if (!payload) return { status: 'unknown', reason: 'GitHub response was too large or invalid' }
    if (typeof payload.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(payload.sha)) {
      return { status: 'unknown', reason: 'GitHub response did not contain a commit' }
    }
    const current = currentCommit.toLowerCase()
    const latest = payload.sha.toLowerCase()
    if (latest.startsWith(current) || current.startsWith(latest)) {
      return { status: 'current', current, latest }
    }
    const url =
      typeof payload.html_url === 'string' && payload.html_url.startsWith('https://github.com/')
        ? payload.html_url
        : `https://github.com/${KITCODE_REPOSITORY}/commits/main`
    return { status: 'available', current, latest, url }
  } catch (error) {
    return {
      status: 'unknown',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'GitHub check timed out'
          : 'GitHub check failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonBounded(response: Response): Promise<unknown | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined))
  } catch {
    return null
  }
}
