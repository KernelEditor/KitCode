import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { ProviderError } from './types'

export const REQUEST_TIMEOUT_MS = 600_000
export const MAX_RETRIES = 3

const EXCERPT_CHARS = 240
const CAPTURE_CHARS = EXCERPT_CHARS * 2

const RETRYABLE_STATUS = new Set([408, 409, 429])
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 422])

const SECRET =
  /Bearer\s+\S+|\b(?:sk|pk|rk|xai|gsk|ghp|gho|hf|nvapi|glpat)[-_][A-Za-z0-9._-]{4,}|\b[A-Za-z0-9]{32,}\b/g
const NAMED_SECRET =
  /((?:["']?)(?:authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|cookie|set-cookie)(?:["']?)\s*[:=]\s*)(?:Bearer\s+\S+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi

const CONNECTION_REASONS: Record<string, string> = {
  ENOTFOUND: 'the hostname does not resolve',
  EAI_AGAIN: 'the DNS lookup failed, the resolver is unreachable or throttled',
  ECONNREFUSED: 'nothing is listening on that host and port',
  ECONNRESET: 'the connection was reset before the response finished',
  ECONNABORTED: 'the connection was aborted',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  EPIPE: 'the connection closed mid-request',
  UND_ERR_SOCKET: 'the socket closed unexpectedly',
  CERT_HAS_EXPIRED: 'the TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate chain cannot be verified',
}

export function describeProviderFailure(error: unknown, providerId: string): string {
  const abort = abortKind(error)
  if (abort === 'user') return `Request to "${providerId}" was cancelled.`
  if (abort === 'timeout') {
    return `Request to "${providerId}" ran out of time before the provider answered — it may be overloaded, try again.`
  }

  const status = statusOf(error)
  if (status !== undefined) return describeStatus(status, providerId, error)

  const reason = connectionReason(error)
  if (reason) {
    return `Cannot reach "${providerId}": ${reason}. Check the base URL and your network.`
  }

  return `Request to "${providerId}" failed — ${snippet(messageOf(error))}`
}

export function isRetryableFailure(error: unknown): boolean {
  const abort = abortKind(error)
  if (abort === 'user') return false
  if (abort === 'timeout') return true

  const status = statusOf(error)
  if (status === undefined) return connectionReason(error) !== undefined
  if (PERMANENT_STATUS.has(status)) return false
  return RETRYABLE_STATUS.has(status) || status >= 500
}

function statusOf(error: unknown): number | undefined {
  const value = prop(error, 'status') ?? prop(error, 'statusCode')
  return typeof value === 'number' && value >= 100 ? value : undefined
}

export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || abortKind(error) === 'user'
}

export function isConnectionFailure(error: unknown): boolean {
  return connectionReason(error) !== undefined
}

export function toProviderError(error: unknown, providerId: string): ProviderError {
  return new ProviderError(describeProviderFailure(error, providerId), providerId, statusOf(error), {
    cause: error,
  })
}

export interface ResponseCapture {
  fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>
  succeeded(): boolean
  head(): Promise<string>
}

export function captureResponseHead(): ResponseCapture {
  let ok = false
  let head: Promise<string> = Promise.resolve('')
  return {
    succeeded: () => ok,
    head: () => head,
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      ok = response.ok
      if (!response.body) {
        head = Promise.resolve('')
        return response
      }
      const [forward, copy] = response.body.tee()
      head = readHead(copy)
      return new Response(forward, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
  }
}

async function readHead(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < CAPTURE_CHARS) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    return text
  } finally {
    void reader.cancel().catch(() => {})
  }
  return text
}

export async function invalidStreamError(
  providerId: string,
  capture: ResponseCapture,
  cause?: unknown,
): Promise<ProviderError> {
  const excerpt = snippet(await capture.head(), EXCERPT_CHARS)
  const detail = excerpt === '' ? 'the body was empty' : `the body began: ${excerpt}`
  return new ProviderError(
    `"${providerId}" returned a response that is not a valid streaming chat completion — no stream events arrived and ${detail}. The endpoint may speak a different protocol than the one configured for it.`,
    providerId,
    undefined,
    cause === undefined ? undefined : { cause },
  )
}

function describeStatus(status: number, providerId: string, error: unknown): string {
  const detail = detailOf(error, status)
  const wait = retryAfterSeconds(error)
  const after = wait === undefined ? undefined : `retry after ${wait}s`

  if (status === 401) {
    return `The API key for "${providerId}" was rejected (401) — re-run: kitcode add <url>`
  }
  if (status === 403) {
    return `The API key for "${providerId}" is valid but has no access to this model (403)${detail}`
  }
  if (status === 404) {
    return `"${providerId}" has no such model, or the base URL is wrong (404)${detail}`
  }
  if (status === 408) {
    return `Request to "${providerId}" timed out (408) — ${after ?? 'try again'}`
  }
  if (status === 429) {
    return `"${providerId}" rate limited this request (429) — ${after ?? 'try again shortly'}`
  }
  if (status >= 500) {
    return `"${providerId}" is down or overloaded (${status}) — try again shortly`
  }
  return `"${providerId}" rejected the request (${status})${detail}`
}

function abortKind(error: unknown): 'user' | 'timeout' | undefined {
  if (
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return 'timeout'
  }
  if (error instanceof Anthropic.APIUserAbortError || error instanceof OpenAI.APIUserAbortError) {
    return 'user'
  }
  const name = prop(error, 'name')
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'user'
  return undefined
}

function connectionReason(error: unknown): string | undefined {
  const links = chain(error)
  for (const link of links) {
    for (const candidate of [link, ...siblings(link)]) {
      const code = prop(candidate, 'code')
      const known = typeof code === 'string' ? CONNECTION_REASONS[code] : undefined
      if (known) return `${known} (${code})`
    }
  }

  const deepest = links[links.length - 1]
  if (links.length > 1 && deepest instanceof Error) return snippet(deepest.message)

  const message = messageOf(error)
  return /fetch failed|connection error|socket|network/i.test(message) ? snippet(message) : undefined
}

function chain(error: unknown): unknown[] {
  const links: unknown[] = []
  let current = error
  while (current !== null && typeof current === 'object' && links.length < 5) {
    links.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return links
}

function siblings(link: unknown): unknown[] {
  const errors = prop(link, 'errors')
  return Array.isArray(errors) ? errors.slice(0, 4) : []
}

function retryAfterSeconds(error: unknown): number | undefined {
  const millis = Number(header(error, 'retry-after-ms'))
  if (Number.isFinite(millis) && millis > 0) return Math.ceil(millis / 1000)

  const raw = header(error, 'retry-after')
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - Date.now()) / 1000))
}

function header(error: unknown, name: string): string | undefined {
  const headers = prop(error, 'headers')
  if (headers === null || typeof headers !== 'object') return undefined
  const bag = headers as { get?: (key: string) => string | null }
  if (typeof bag.get === 'function') return bag.get(name) ?? undefined
  const value = (headers as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

function detailOf(error: unknown, status: number): string {
  const raw = bodyMessage(error) ?? messageOf(error).replace(new RegExp(`^${status}\\s+`), '')
  const text = snippet(raw)
  if (text === '' || text === String(status) || text === 'status code (no body)') return ''
  return ` — ${text}`
}

function bodyMessage(error: unknown): string | undefined {
  const body = prop(error, 'error')
  const nested = prop(body, 'error')
  const candidates = [prop(body, 'message'), prop(nested, 'message'), prop(body, 'detail')]
  const found = candidates.find((value) => typeof value === 'string' && value.trim() !== '')
  return typeof found === 'string' ? found : undefined
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return 'unknown error'
  return String(error)
}

function snippet(text: string, limit = 160): string {
  return redactSecrets(oneLine(text)).slice(0, limit)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function redactSecrets(text: string, knownSecrets: Iterable<string> = []): string {
  let safe = text.replace(NAMED_SECRET, '$1[redacted]').replace(SECRET, '[redacted]')
  for (const secret of knownSecrets) {
    if (secret.length >= 4) safe = safe.split(secret).join('[redacted]')
  }
  return safe
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}
