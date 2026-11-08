import type { ChatRequest, Provider, StreamEvent } from '../providers/types'
import { ProviderError } from '../providers/types'

// Rate limits are transient and often lift after a few seconds; stop the turn
// only when the endpoint keeps refusing for roughly a minute straight.
const MAX_RETRIES = 9
const INITIAL_BACKOFF_MS = 1000

export async function* streamWithRetry(
  provider: Provider,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  request = { ...request, signal }
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) return
    let emittedOutput = false
    try {
      const stream = provider.stream(request)[Symbol.asyncIterator]()
      let cancel!: () => void
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const cancelled = new Promise<IteratorResult<StreamEvent>>((resolve) => {
        // Let cooperative adapters flush final usage and partial content, but
        // do not wait indefinitely for an endpoint that ignores cancellation.
        cancel = () => {
          cancelTimer ??= setTimeout(() => resolve({ done: true, value: undefined }), 100)
        }
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      })
      try {
        for (;;) {
          const next = await Promise.race([stream.next(), cancelled])
          if (next.done) break
          if (!signal.aborted || next.value.type === 'usage' || next.value.type === 'done') {
            if (next.value.type !== 'rate_limits' && next.value.type !== 'retrying') emittedOutput = true
            yield next.value
          }
          if (next.value.type === 'done') break
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        if (cancelTimer !== undefined) clearTimeout(cancelTimer)
        void stream.return?.().catch(() => undefined)
      }
      return
    } catch (error) {
      if (signal.aborted) return
      // Replaying a partially displayed stream duplicates text and may change
      // tool arguments. Retry only requests that have not produced output.
      if (emittedOutput) throw error
      lastError = error
      if (attempt >= MAX_RETRIES) break
      const waitMs = retryBackoffMs(error, attempt)
      if (waitMs > 0) {
        yield {
          type: 'retrying',
          attempt: attempt + 2,
          waitMs,
          reason: error instanceof Error ? error.message : String(error),
        }
        try {
          await sleep(waitMs, signal)
        } catch (error) {
          if (signal.aborted) return
          throw error
        }
        continue
      }
      break
    }
  }
  if (lastError) throw lastError
}

function retryBackoffMs(error: unknown, attempt: number): number {
  if (!isRateLimitError(error)) return 0
  const serverWait = retryAfterFromError(error)
  if (serverWait > 0) return Math.min(serverWait, 60_000)
  return Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, 30_000)
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false
  return error.status === 429
}

function retryAfterFromError(error: unknown): number {
  const cause = (error as { cause?: unknown })?.cause
  const headers = (cause as { headers?: unknown })?.headers
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const ms = Number((headers as { get: (k: string) => string | null }).get('retry-after-ms'))
    if (Number.isFinite(ms) && ms > 0) return ms
    const raw = (headers as { get: (k: string) => string | null }).get('retry-after')
    if (raw) {
      const s = Number(raw)
      if (Number.isFinite(s) && s > 0) return s * 1000
      const date = Date.parse(raw)
      if (!Number.isFinite(s) && Number.isFinite(date)) return Math.max(0, date - Date.now())
    }
  }
  return 0
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const finish = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      clearTimeout(id)
      reject(signal.reason ?? new Error('Aborted'))
    }
    const id = setTimeout(finish, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
