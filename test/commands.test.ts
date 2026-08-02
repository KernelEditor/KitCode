import { describe, expect, it } from 'vitest'
import { COMMANDS, closestCommand, matchCommands } from '../src/ui/commands'
import { LANGS, stringsFor } from '../src/ui/i18n'
import { PRESETS, makeTheme, resolveAccent } from '../src/ui/theme'
import { formatDuration } from '../src/ui/time'

const names = (line: string) => matchCommands(line).map((command) => command.name)

describe('matchCommands', () => {
  it('lists everything for a bare slash', () => {
    expect(matchCommands('/')).toHaveLength(COMMANDS.length)
  })

  it('prefers prefix matches', () => {
    expect(names('/th')).toEqual(['thinking', 'theme'])
    expect(names('/mod')).toEqual(['model'])
  })

  it('falls back to substring then subsequence', () => {
    expect(names('/ypass')).toEqual(['bypass'])
    expect(names('/thm')).toContain('theme')
  })

  it('stops suggesting once an argument is being typed', () => {
    expect(matchCommands('/prompt save x')).toEqual([])
  })

  it('ignores plain text', () => {
    expect(matchCommands('hello')).toEqual([])
  })
})

describe('closestCommand', () => {
  it('recovers a typo', () => {
    expect(closestCommand('modle')?.name).toBe('model')
    expect(closestCommand('hepl')?.name).toBe('help')
  })

  it('gives up on nonsense rather than guessing wildly', () => {
    expect(closestCommand('qwertyuiop')).toBeUndefined()
  })
})

describe('i18n', () => {
  const en = stringsFor('en')
  const ru = stringsFor('ru')

  it('has the same keys in every language', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
  })

  it('describes every slash command in every language', () => {
    for (const { key } of LANGS) {
      const strings = stringsFor(key)
      for (const command of COMMANDS) {
        expect(strings.cmd[command.name], `${key}: /${command.name}`).toBeTruthy()
      }
    }
  })

  it('has no leftover English in the Russian dictionary', () => {
    expect(ru.cancelled).not.toBe(en.cancelled)
    expect(ru.placeholder).not.toBe(en.placeholder)
    expect(ru.cmd.model).not.toBe(en.cmd.model)
  })

  it('falls back to English for an unset language', () => {
    expect(stringsFor(undefined)).toBe(en)
  })
})

describe('theme', () => {
  it('defaults to purple', () => {
    expect(makeTheme(undefined).accent).toBe(PRESETS.purple)
  })

  it('accepts a preset name or a hex value', () => {
    expect(resolveAccent('green')).toBe(PRESETS.green)
    expect(resolveAccent('#ff8800')).toBe('#ff8800')
  })

  it('falls back to the default for garbage', () => {
    expect(resolveAccent('not-a-colour')).toBe(PRESETS.purple)
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [900, '1s'],
    [59_000, '59s'],
    [60_000, '1m00s'],
    [134_000, '2m14s'],
    [3_600_000, '1h00m'],
    [7_530_000, '2h05m'],
  ])('%ims -> %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('never renders a negative clock', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
})
