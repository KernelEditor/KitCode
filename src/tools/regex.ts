import { Worker } from 'node:worker_threads'

const MATCH_TIMEOUT_MS = 300

const WORKER_SOURCE = String.raw`
  const { parentPort } = require('node:worker_threads')

  parentPort.on('message', ({ id, pattern, lines, maxMatches }) => {
    try {
      const regex = new RegExp(pattern)
      const indexes = []
      for (let index = 0; index < lines.length; index += 1) {
        const matched = regex.test(lines[index])
        regex.lastIndex = 0
        if (matched) indexes.push(index)
        if (indexes.length >= maxMatches) break
      }
      parentPort.postMessage({ id, indexes })
    } catch (error) {
      parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
`

interface WorkerReply {
  id: number
  indexes?: number[]
  error?: string
}

export interface RegexMatcher {
  match(lines: string[], maxMatches: number, signal: AbortSignal): Promise<number[]>
  close(): Promise<void>
}

/** Execute untrusted JavaScript regular expressions outside the UI process. */
export function createRegexMatcher(pattern: string): RegexMatcher {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  // A request-specific listener reports errors below; this listener also keeps
  // a late worker failure from becoming an unhandled EventEmitter error.
  worker.on('error', () => undefined)
  let nextId = 0
  let closed = false

  return {
    match(lines, maxMatches, signal) {
      if (closed) return Promise.reject(new Error('Regular-expression worker is closed.'))
      if (signal.aborted) return Promise.reject(new Error('Search interrupted by the user.'))

      const id = ++nextId
      return new Promise<number[]>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, indexes?: number[]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          worker.off('message', onMessage)
          worker.off('error', onError)
          if (error) reject(error)
          else resolve(indexes ?? [])
        }
        const onMessage = (reply: WorkerReply) => {
          if (reply.id !== id) return
          finish(reply.error ? new Error(reply.error) : undefined, reply.indexes)
        }
        const onError = (error: Error) => finish(error)
        const onAbort = () => {
          closed = true
          void worker.terminate()
          finish(new Error('Search interrupted by the user.'))
        }
        const timer = setTimeout(() => {
          closed = true
          void worker.terminate()
          finish(
            new Error(
              `Regular expression exceeded the ${MATCH_TIMEOUT_MS} ms per-file time limit. Narrow or simplify it.`,
            ),
          )
        }, MATCH_TIMEOUT_MS)

        signal.addEventListener('abort', onAbort, { once: true })
        worker.on('message', onMessage)
        worker.on('error', onError)
        worker.postMessage({ id, pattern, lines, maxMatches })
      })
    },
    async close() {
      if (closed) return
      closed = true
      await worker.terminate()
    },
  }
}
