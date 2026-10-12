import type { AgentEvent } from '../core/types'

// Rough chars-per-token for the live estimate; the exact rate replaces it as
// soon as the provider reports the request's output token count.
const CHARS_PER_TOKEN = 4
// Too-short windows give wild numbers right after the first token.
const MIN_LIVE_MS = 1000

export interface SpeedMeter {
  streamedChars: number
  firstTokenAt: number | null
  last: number | null
}

export interface SpeedReading {
  tokensPerSecond: number
  live: boolean
}

export function createSpeedMeter(): SpeedMeter {
  return { streamedChars: 0, firstTokenAt: null, last: null }
}

export function recordSpeed(meter: SpeedMeter, event: AgentEvent, now = Date.now()): void {
  switch (event.type) {
    case 'turn_start':
      meter.streamedChars = 0
      meter.firstTokenAt = null
      break
    case 'text_delta':
    case 'thinking_delta':
      meter.firstTokenAt ??= now
      meter.streamedChars += event.text.length
      break
    case 'speed':
      meter.last = event.outputTokens / (event.ms / 1000)
      meter.streamedChars = 0
      meter.firstTokenAt = null
      break
  }
}

export function readSpeed(meter: SpeedMeter, busy: boolean, now = Date.now()): SpeedReading | null {
  if (busy && meter.firstTokenAt !== null && meter.streamedChars > 0) {
    const ms = now - meter.firstTokenAt
    if (ms >= MIN_LIVE_MS) {
      return { tokensPerSecond: meter.streamedChars / CHARS_PER_TOKEN / (ms / 1000), live: true }
    }
  }
  return meter.last === null || !Number.isFinite(meter.last) ? null : { tokensPerSecond: meter.last, live: false }
}
