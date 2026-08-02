import { describe, expect, it } from 'vitest'
import { appendInputHistory, moveInputHistory } from '../src/ui/history'
import { normalizeHotkey } from '../src/ui/layout'

describe('normalizeHotkey', () => {
  it('passes English letters through untouched (lowercased)', () => {
    expect(normalizeHotkey('y')).toBe('y')
    expect(normalizeHotkey('a')).toBe('a')
    expect(normalizeHotkey('n')).toBe('n')
  })

  it('lowercases uppercase English letters', () => {
    expect(normalizeHotkey('Y')).toBe('y')
    expect(normalizeHotkey('A')).toBe('a')
  })

  it('maps Russian ЁЙЦУКЕН letters to their English hotkeys', () => {
    expect(normalizeHotkey('н')).toBe('y')
    expect(normalizeHotkey('ф')).toBe('a')
    expect(normalizeHotkey('т')).toBe('n')
  })

  it('handles uppercase Russian letters', () => {
    expect(normalizeHotkey('Н')).toBe('y')
  })

  it('returns an empty string for undefined/empty input', () => {
    expect(normalizeHotkey(undefined)).toBe('')
    expect(normalizeHotkey('')).toBe('')
  })

  it('passes through unknown characters unchanged', () => {
    expect(normalizeHotkey('1')).toBe('1')
    expect(normalizeHotkey('q')).toBe('q')
  })
})

describe('prompt history', () => {
  it('walks backward and forward, then restores the unfinished draft', () => {
    const history = ['first prompt', 'second prompt']
    const latest = moveInputHistory(history, null, 'unfinished', '', 'previous')
    expect(latest).toEqual({ index: 1, value: 'second prompt', draft: 'unfinished' })

    const older = moveInputHistory(history, latest.index, latest.value, latest.draft, 'previous')
    expect(older).toEqual({ index: 0, value: 'first prompt', draft: 'unfinished' })

    const newer = moveInputHistory(history, older.index, older.value, older.draft, 'next')
    const draft = moveInputHistory(history, newer.index, newer.value, newer.draft, 'next')
    expect(draft).toEqual({ index: null, value: 'unfinished', draft: 'unfinished' })
  })

  it('ignores adjacent duplicates and caps retained prompts', () => {
    let history = appendInputHistory([], ' one ')
    history = appendInputHistory(history, 'one')
    history = appendInputHistory(history, 'two', 2)
    history = appendInputHistory(history, 'three', 2)
    expect(history).toEqual(['two', 'three'])
  })
})
