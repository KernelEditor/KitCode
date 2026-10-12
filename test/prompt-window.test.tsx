import { renderToString } from 'ink'
import { describe, expect, it } from 'vitest'
import { PromptInput, expandPastes, inputWindow } from '../src/ui/components/PromptInput'
import { stringsFor } from '../src/ui/i18n'

const chars = (text: string) => [...text]

describe('prompt input window', () => {
  it('wraps rows and keeps the cursor row in view', () => {
    const text = 'abcdefghij\nklm'
    const end = inputWindow(chars(text), text.length, 6, 2)
    expect(end.total).toBe(3)
    expect(end.rows).toEqual([{ text: 'fghij' }, { text: 'klm', cursor: 3 }])
    const start = inputWindow(chars(text), 0, 6, 2)
    expect(start.first).toBe(0)
    expect(start.rows[0]).toEqual({ text: 'abcde', cursor: 0 })
  })

  it('puts a cursor at a wrap point on the next row', () => {
    const view = inputWindow(chars('abcdefgh'), 5, 6, 3)
    expect(view.rows).toEqual([{ text: 'abcde' }, { text: 'fgh', cursor: 0 }])
  })

  it('shows the end of a long prompt instead of its first rows', () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    const output = renderToString(
      <PromptInput disabled={false} value={text} onChange={() => {}} onSubmit={() => {}} history={[]} />,
      { columns: 60 },
    )
    expect(output).toContain('line 29')
    expect(output).not.toContain('line 0\n')
    expect(output).toContain('lines 25–30 of 30')
  })
})

describe('collapsed pastes', () => {
  it('expands paste tokens in both languages on submit', () => {
    const pastes = new Map([[1, 'FULL ONE'], [2, 'FULL TWO']])
    const en = stringsFor('en').pasteToken(1, 120, 5000)
    const ru = stringsFor('ru').pasteToken(2, 1, 3000)
    expect(en).toBe('[paste #1 · 120 lines]')
    expect(ru).toBe('[вставка #2 · 3000 символов]')
    expect(expandPastes(`look: ${en} and ${ru}`, pastes)).toBe('look: FULL ONE and FULL TWO')
    expect(expandPastes('[paste #9 · 3 lines]', pastes)).toBe('[paste #9 · 3 lines]')
  })
})
