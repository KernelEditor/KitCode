import { describe, expect, it } from 'vitest'
import { anthropicEffort, effectiveEffort, openAiEffort, resolveEffort } from '../src/providers/effort'
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
    expect(openAiEffort('kimi-k3', 'high')).toBe('high')
    expect(openAiEffort('kimi-k3', 'max')).toBe('high')
  })
  it('does not treat words that merely contain a keyword as hard tasks', () => {
    const ask = (text: string) => resolveEffort('auto', [{ role: 'user', content: [{ type: 'text', text }] }])
    expect(ask('what is the latest prefix?')).toBe('medium')
    expect(ask('add tests for the parser')).toBe('high')
  })
  it('sends only the effort levels each Claude model accepts', () => {
    expect(anthropicEffort('claude-opus-5-5', 'xhigh')).toBe('xhigh')
    expect(anthropicEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
    expect(anthropicEffort('claude-sonnet-4-6', 'max')).toBe('max')
    expect(anthropicEffort('claude-opus-4-5-20251101', 'max')).toBe('high')
    expect(anthropicEffort('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(anthropicEffort('claude-sonnet-4-5-20250929', 'high')).toBeUndefined()
    expect(anthropicEffort('us.anthropic.claude-opus-4-8', 'max')).toBe('max')
    expect(anthropicEffort('glm-4.6', 'high')).toBeUndefined()
  })
  it('resolves auto before applying model limits', () => {
    const fix = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fix the bug' }] }]
    expect(effectiveEffort('anthropic', 'claude-opus-5', 'auto', fix)).toBe('high')
    expect(effectiveEffort('openai', 'gemini-2.5-pro', 'max', fix)).toBe('high')
    expect(effectiveEffort('openai', 'some-model', 'high', fix)).toBe('high')
  })
})
