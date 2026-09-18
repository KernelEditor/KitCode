import { redactSecrets } from '../providers/errors'
import { modelInfoFromRaw } from '../providers/model-info'
import type { ModelInfo } from '../providers/types'
import { isAllowedEndpointUrl, providerIdSchema } from './schema'
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
): Promise<DetectedProvider[]> {
  const fetchImpl = withTimeout(opts.fetchImpl ?? fetch, opts.timeoutMs ?? DETECT_TIMEOUT_MS)
  const baseUrl = normaliseBaseUrl(rawUrl)
  if (!isAllowedEndpointUrl(baseUrl)) {
    throw new Error('API URL must use https; plain http is only allowed for localhost or 127.0.0.1.')
  }
  const candidateId = opts.name ?? providerIdFromUrl(baseUrl)
  const parsedId = providerIdSchema.safeParse(candidateId)
  if (!parsedId.success) {
    throw new Error(`Invalid provider name "${candidateId}": ${parsedId.error.issues[0]?.message ?? 'invalid name'}`)
  }
  const id = parsedId.data

  if (hostname(baseUrl) === anthropicHost) {
    const probed = await probe(
      fetchImpl,
      `${anthropicBaseUrl}/v1/models?limit=1000`,
      anthropicHeaders(apiKey),
    )
    return [
      {
        id,
        config: { type: 'anthropic', baseUrl: anthropicBaseUrl },
        models: probed.ok ? parseModelList(probed.body) : [],
      },
    ]
  }

  const found: Found[] = []
  let last: Probe | undefined
  for (const candidate of candidateBaseUrls(baseUrl)) {
    if (found.length === schemes.length) break
    const url = `${candidate}/models`
    for (const scheme of schemes) {
      const attempt = await probe(fetchImpl, url, schemeHeaders(scheme, apiKey))
      last = attempt
      // A 404 means this path is not an API root at all, and status 0 means the
      // host never answered; the other credential style will not conjure one up.
      if (attempt.status === 404 || attempt.status === 0) break
      if (attempt.ok && isModelListBody(attempt.body)) record(found, candidate, scheme, attempt.body)
      if (found.length === schemes.length) break
    }
    if (found.length === 0 && !last!.ok && last!.status !== 404 && last!.status !== 0) break
  }

  if (found.length === 0) throw new Error(describeFailure(last!, apiKey))
  return found.map((entry, index) => ({
    id: index === 0 ? id : `${id.slice(0, MAX_ID_STEM)}-${entry.type}`,
    config: { type: entry.type, baseUrl: entry.baseUrl },
    models: entry.models,
  }))
}

type Scheme = 'bearer' | 'anthropic'

const schemes: Scheme[] = ['bearer', 'anthropic']

interface Found {
  type: ProviderConfig['type']
  baseUrl: string
  models: ModelInfo[]
  fingerprint: string
}

const MAX_ID_STEM = 120

function schemeHeaders(scheme: Scheme, apiKey: string): Record<string, string> {
  return scheme === 'bearer' ? { Authorization: `Bearer ${apiKey}` } : anthropicHeaders(apiKey)
}

// One provider per protocol, first match wins. Endpoints that answer both
// credential styles with the same catalogue are one backend, not two.
function record(found: Found[], candidate: string, scheme: Scheme, body: unknown): void {
  const type: ProviderConfig['type'] =
    scheme === 'anthropic' || advertisesAnthropicProtocol(body) ? 'anthropic' : 'openai'
  if (found.some((entry) => entry.type === type)) return
  const models = parseModelList(body)
  const fingerprint = models
    .map((model) => model.id)
    .sort()
    .join('\n')
  if (found.some((entry) => entry.fingerprint === fingerprint)) return
  found.push({
    type,
    baseUrl: type === 'anthropic' ? anthropicRoot(candidate) : candidate,
    models,
    fingerprint,
  })
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
  const candidate = label.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'provider'
  return providerIdSchema.safeParse(candidate).success ? candidate : `provider-${candidate}`
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

  // Judge each model on its own advertisement rather than a union across the
  // catalogue: a gateway whose every model speaks anthropic is an anthropic
  // endpoint even when some of them also accept openai calls.
  const advertised = entries.map((entry) => stringList(entry['supported_endpoint_types']))
  if (advertised.some((types) => types.length > 0)) {
    return advertised.every((types) => types.includes('anthropic'))
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

function describeFailure(attempt: Probe, apiKey: string): string {
  const status = attempt.status === 0 ? 'request failed' : `HTTP ${attempt.status}`
  const snippet = redactSecrets(attempt.text.trim(), [apiKey]).slice(0, 200)
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
