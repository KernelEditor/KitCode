import { describe, expect, it } from 'vitest'
import { resolveEffort, openAiEffort } from '../src/providers/effort'
import { configSchema } from '../src/config/schema'

describe('effort selection', () => {
  it('accepts auto and chooses from the latest user task', () => {
    expect(configSchema.parse({ effort: 'auto' }).effort).toBe('auto')
    expect(resolveEffort('auto', [{ role: 'user', content: [{ type: 'text', text: 'Привет' }] }])).toBe('medium')
    expect(resolveEffort('auto', [{ role: 'user', content: [{ type: 'text', text: 'Исправь баг' }] }])).toBe('high')
    expect(resolveEffort('low', [])).toBe('low')
  })
  it('keeps advanced levels for newer GPT variants and caps legacy models', () => {
    expect(openAiEffort('gpt-5.2', 'xhigh')).toBe('xhigh')
    expect(openAiEffort('gpt-5.2', 'max')).toBe('xhigh')
    expect(openAiEffort('gpt-5', 'max')).toBe('high')
    expect(openAiEffort('o3', 'xhigh')).toBe('high')
    expect(openAiEffort('unknown', 'high')).toBeUndefined()
  })
})
