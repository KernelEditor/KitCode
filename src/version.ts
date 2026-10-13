import pkg from '../package.json' with { type: 'json' }

declare const __KITCODE_COMMIT__: string

export const KITCODE_VERSION = pkg.version
export const KITCODE_REPOSITORY = 'KernelEditor/KitCode'
export const KITCODE_COMMIT =
  typeof __KITCODE_COMMIT__ === 'string' && __KITCODE_COMMIT__ !== ''
    ? __KITCODE_COMMIT__
    : 'development'

/**
 * The User-Agent sent to providers: KitCode's name in front of the SDK's own
 * ("KitCode/1.4.3 OpenAI/JS 7.3.0"). Providers can tell the client apart,
 * while checks that look for the SDK token keep passing.
 */
export function kitcodeUserAgent(sdkUserAgent: string): string {
  return `KitCode/${KITCODE_VERSION} ${sdkUserAgent}`.trim()
}

/** The SDK's own User-Agent, or '' if a future SDK stops exposing it. */
export function sdkUserAgent(client: unknown): string {
  const read = (client as { getUserAgent?: unknown } | null)?.getUserAgent
  try {
    return typeof read === 'function' ? String(read.call(client)) : ''
  } catch {
    return ''
  }
}

/**
 * Default headers for an SDK client: the KitCode User-Agent first, then the
 * provider's configured headers, so a User-Agent set there (in any letter
 * case) still wins.
 */
export function withKitcodeUserAgent(
  sdkUserAgent: string,
  configured: Record<string, string> = {},
): Record<string, string> {
  const overridden = Object.keys(configured).some((name) => name.toLowerCase() === 'user-agent')
  return overridden ? { ...configured } : { 'User-Agent': kitcodeUserAgent(sdkUserAgent), ...configured }
}
