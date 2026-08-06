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

export function createRegexMatcher(pattern: string): RegexMatcher {
  let worker = newWorker()
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
          worker.thread.off('message', onMessage)
          worker.thread.off('error', onError)
          if (error) reject(error)
          else resolve(indexes ?? [])
        }
        const onMessage = (reply: WorkerReply) => {
          if (reply.id !== id) return
          finish(reply.error ? new Error(reply.error) : undefined, reply.indexes)
        }
        const onError = (error: Error) => finish(error)
        const onAbort = () => {
          
          
          void worker.thread.terminate()
          worker = newWorker()
          finish(new Error('Search interrupted by the user.'))
        }
        const timer = setTimeout(() => {
          void worker.thread.terminate()
          worker = newWorker()
          finish(
            new Error(
              `Regular expression exceeded the ${MATCH_TIMEOUT_MS} ms per-file time limit. Narrow or simplify it.`,
            ),
          )
        }, MATCH_TIMEOUT_MS)

        signal.addEventListener('abort', onAbort, { once: true })
        worker.thread.on('message', onMessage)
        worker.thread.on('error', onError)
        worker.thread.postMessage({ id, pattern, lines, maxMatches })
      })
    },
    async close() {
      if (closed) return
      closed = true
      await worker.thread.terminate()
    },
  }
}

interface WorkerHandle {
  thread: Worker
}

function newWorker(): WorkerHandle {
  const thread = new Worker(WORKER_SOURCE, { eval: true })
  
  
  thread.on('error', () => undefined)
  return { thread }
}
