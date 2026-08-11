import { KITCODE_VERSION } from '../version'

const UPDATE_URL = 'https://registry.npmjs.org/%40kernelonpanic%2Fkitcode/latest'
const PACKAGE_URL = 'https://www.npmjs.com/package/@kernelonpanic/kitcode'
const TIMEOUT_MS = 4_000
const MAX_RESPONSE_BYTES = 128_000

export type UpdateCheck =
  | { status: 'current'; current: string; latest: string }
  | { status: 'available'; current: string; latest: string; url: string }
  | { status: 'unknown'; reason: string }

export async function checkForUpdates(
  fetcher: typeof fetch = fetch,
  currentVersion = KITCODE_VERSION,
): Promise<UpdateCheck> {
  if (!parseSemver(currentVersion)) {
    return { status: 'unknown', reason: 'installed KitCode version is not valid semver' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetcher(UPDATE_URL, {
      headers: {
        accept: 'application/json',
        'user-agent': `KitCode/${currentVersion}`,
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { status: 'unknown', reason: `npm registry returned ${response.status}` }
    }
    const payload = (await readJsonBounded(response)) as { version?: unknown } | null
    if (!payload) return { status: 'unknown', reason: 'npm response was too large or invalid' }
    if (typeof payload.version !== 'string' || !parseSemver(payload.version)) {
      return { status: 'unknown', reason: 'npm response did not contain a valid version' }
    }

    const latest = payload.version
    if (compareSemver(latest, currentVersion) <= 0) {
      return { status: 'current', current: currentVersion, latest }
    }
    return {
      status: 'available',
      current: currentVersion,
      latest,
      url: `${PACKAGE_URL}/v/${encodeURIComponent(latest)}`,
    }
  } catch (error) {
    return {
      status: 'unknown',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'npm update check timed out'
          : 'npm update check failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

interface Semver {
  core: [bigint, bigint, bigint]
  prerelease: string[]
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) throw new Error('Cannot compare invalid semantic versions')
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n
    const y = b.core[index] ?? 0n
    if (x !== y) return x > y ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function parseSemver(value: string): Semver | null {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
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
