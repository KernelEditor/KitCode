import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/prompt'

describe('buildSystemPrompt', () => {
  it('appends a custom system prompt after the built-in instructions', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/work',
      toolNames: ['read', 'write'],
      systemPrompt: 'Always answer in Russian.',
    })
    expect(prompt).toContain('You are kitcode')
    expect(prompt).toContain('Working directory:')
    expect(prompt).toContain('Always answer in Russian.')
    // Custom instructions must come last so the model reads them as an overlay.
    expect(prompt.indexOf('You are kitcode')).toBeLessThan(prompt.indexOf('Always answer in Russian.'))
  })

  it('omits the section when no system prompt is set', () => {
    const prompt = buildSystemPrompt({ cwd: '/tmp/work', toolNames: [] })
    expect(prompt).not.toContain('Additional instructions')
  })

  it('trims whitespace and ignores a blank system prompt', () => {
    const prompt = buildSystemPrompt({
      cwd: '/tmp/work',
      toolNames: [],
      systemPrompt: '   \n\n  ',
    })
    expect(prompt).not.toContain('Additional instructions')
  })
})
