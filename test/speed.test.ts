import { describe, expect, it } from 'vitest'
import { tokens } from '../src/core/usage'
import { normalizeOpenAiUsage } from '../src/providers/openai-compat'
import { createSpeedMeter, readSpeed, recordSpeed } from '../src/ui/speed'

describe('tokens per second', () => {
  it('estimates live from streamed text, then switches to the provider count', () => {
    const meter = createSpeedMeter()
    recordSpeed(meter, { type: 'turn_start' }, 0)
    recordSpeed(meter, { type: 'text_delta', text: 'x'.repeat(400) }, 1_000)
    expect(readSpeed(meter, true, 1_500)).toBeNull()
    expect(readSpeed(meter, true, 3_000)).toEqual({ tokensPerSecond: 50, live: true })
    recordSpeed(meter, { type: 'speed', model: 'p/m', outputTokens: 120, ms: 2_000 }, 3_000)
    expect(readSpeed(meter, true, 3_000)).toEqual({ tokensPerSecond: 60, live: false })
    expect(readSpeed(meter, false, 9_000)).toEqual({ tokensPerSecond: 60, live: false })
  })
})

describe('token display', () => {
  it('rolls over to M instead of printing 1000k', () => {
    expect(tokens(999)).toBe('999')
    expect(tokens(12_345)).toBe('12.3k')
    expect(tokens(999_960)).toBe('1M')
    expect(tokens(2_500_000)).toBe('2.5M')
  })
  it('reads cache hits from DeepSeek and Kimi usage shapes', () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 }))
      .toEqual({ input: 20, output: 5, cacheWrite: 0, cacheRead: 80 })
    expect(normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 30 }))
      .toEqual({ input: 70, output: 5, cacheWrite: 0, cacheRead: 30 })
    expect(normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 40 } }))
      .toEqual({ input: 50, output: 5, cacheWrite: 40, cacheRead: 10 })
  })
})
