import { redactSecrets } from '../providers/errors'
import { modelInfoFromRaw } from '../providers/model-info'
import type { ModelInfo } from '../providers/types'
import { isAllowedEndpointUrl } from './schema'
import type { ProviderConfig } from './schema'

export interface DetectedProvider {
  id: string
  config: ProviderConfig
  models: ModelInfo[]
}

export interface DetectOptions {
  name?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const DETECT_TIMEOUT_MS = 15_000
const MAX_DETECT_BODY_BYTES = 5_000_000

const anthropicHost = 'api.anthropic.com'
const anthropicBaseUrl = 'https://api.anthropic.com'

export async function detectProvider(
  rawUrl: string,
  apiKey: string,
  opts: DetectOptions = {},
): Promise<DetectedProvider> {
  const fetchImpl = withTimeout(opts.fetchImpl ?? fetch, opts.timeoutMs ?? DETECT_TIMEOUT_MS)
  const baseUrl = normaliseBaseUrl(rawUrl)
  if (!isAllowedEndpointUrl(baseUrl)) {
    throw new Error('API URL must use https; plain http is only allowed for localhost or 127.0.0.1.')
  }
  const id = opts.name ?? providerIdFromUrl(baseUrl)

  if (hostname(baseUrl) === anthropicHost) {
    const probed = await probe(
      fetchImpl,
      `${anthropicBaseUrl}/v1/models?limit=1000`,
      anthropicHeaders(apiKey),
    )
    return {
      id,
      config: { type: 'anthropic', baseUrl: anthropicBaseUrl },
      models: probed.ok ? parseModelList(probed.body) : [],
    }
  }

  let last: Probe | undefined
  for (const candidate of candidateBaseUrls(baseUrl)) {
    const url = `${candidate}/models`
    let attempt = await probe(fetchImpl, url, { Authorization: `Bearer ${apiKey}` })
    last = attempt
    if (attempt.ok && isModelListBody(attempt.body)) {
      const anthropic = advertisesAnthropicProtocol(attempt.body)
      return {
        id,
        config: anthropic
          ? { type: 'anthropic', baseUrl: anthropicRoot(candidate) }
          : { type: 'openai', baseUrl: candidate },
        models: parseModelList(attempt.body),
      }
    }

    if (attempt.status === 401 || attempt.status === 403) {
      attempt = await probe(fetchImpl, url, anthropicHeaders(apiKey))
      last = attempt
      if (attempt.ok) {
        return {
          id,
          config: { type: 'anthropic', baseUrl: anthropicRoot(candidate) },
          models: parseModelList(attempt.body),
        }
      }
    }
    if (!attempt.ok && attempt.status !== 404 && attempt.status !== 0) break
  }

  throw new Error(describeFailure(last!))
}

export function normaliseBaseUrl(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, '')
}

export function providerIdFromUrl(url: string): string {
  const host = hostname(url)
  if (isAddressLiteral(host)) {
    const port = new URL(url).port
    return port ? `local-${port}` : 'local'
  }
  const labels = host.split('.')
  const label = labels.find((part) => part !== 'api' && part !== '') ?? 'provider'
  return label.replace(/[^a-z0-9-]/g, '-')
}

function isAddressLiteral(host: string): boolean {
  return host === 'localhost' || /^[0-9.]+$/.test(host) || host.includes(':')
}

export function parseModelList(body: unknown): ModelInfo[] {
  const data = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((entry) => {
    const model = modelInfoFromRaw(entry)
    return model ? [model] : []
  })
}

interface Probe {
  ok: boolean
  url: string
  status: number
  body: unknown
  text: string
}

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Probe> {
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers })
  } catch (error) {
    return { ok: false, url, status: 0, body: undefined, text: describeThrown(error) }
  }
  let text: string
  try {
    text = await boundedResponseText(response)
  } catch (error) {
    return {
      ok: false,
      url,
      status: response.status,
      body: undefined,
      text: describeThrown(error),
    }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { ok: response.ok, url, status: response.status, body, text }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DETECT_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`response exceeded ${MAX_DETECT_BODY_BYTES / 1_000_000} MB`)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_DETECT_BODY_BYTES) {
        throw new Error(`response exceeded ${MAX_DETECT_BODY_BYTES / 1_000_000} MB`)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const expiry = new Error(`timed out after ${Math.round(timeoutMs / 100) / 10}s`)
    
    
    expiry.name = 'TimeoutError'
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(expiry)
        reject(expiry)
      }, timeoutMs)
    })
    try {
      return await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), expired])
    } finally {
      clearTimeout(timer)
    }
  }
}

function candidateBaseUrls(baseUrl: string): string[] {
  return baseUrl.endsWith('/v1') ? [baseUrl] : [baseUrl, `${baseUrl}/v1`]
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
}

function isModelListBody(body: unknown): boolean {
  return Array.isArray(body) || Array.isArray((body as { data?: unknown } | null)?.data)
}

function anthropicRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '')
}

function advertisesAnthropicProtocol(body: unknown): boolean {
  const entries = modelEntries(body)
  if (entries.length === 0) return false

  const endpointTypes = new Set(
    entries.flatMap((entry) => stringList(entry['supported_endpoint_types'])),
  )
  if (endpointTypes.size > 0) {
    return endpointTypes.has('anthropic') && !endpointTypes.has('openai')
  }

  if (entries.some(isVendorNamespaced)) return false
  return entries.every((entry) => entry['owned_by'] === 'anthropic')
}

function isVendorNamespaced(entry: Record<string, unknown>): boolean {
  return typeof entry['id'] === 'string' && entry['id'].includes('/')
}

function modelEntries(body: unknown): Record<string, unknown>[] {
  const data = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return data.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function describeFailure(attempt: Probe): string {
  const status = attempt.status === 0 ? 'request failed' : `HTTP ${attempt.status}`
  const snippet = redactSecrets(attempt.text.trim()).slice(0, 200)
  const detail = snippet === '' ? '' : `: ${snippet}`
  return `No OpenAI- or Anthropic-compatible API found at ${attempt.url} (${status})${detail}`
}

function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ''
  return `${error.message}${cause}`
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    throw new Error(`Not a valid URL: ${url}`)
  }
}
