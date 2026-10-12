import { describe, expect, it } from 'vitest'
import { COMMANDS, closestCommand, commandRunsWhileBusy, matchCommands } from '../src/ui/commands'
import { shouldAutoCompact } from '../src/core/compact'
import { LANGS, stringsFor } from '../src/ui/i18n'
import { PRESETS, makeTheme, parseAccent, resolveAccent } from '../src/ui/theme'
import { formatDuration } from '../src/ui/time'

const names = (line: string) => matchCommands(line).map((command) => command.name)

describe('matchCommands', () => {
  it('lists everything for a bare slash', () => {
    expect(matchCommands('/')).toHaveLength(COMMANDS.length)
    expect(names('/up')).toContain('update')
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

  it('advertises MCP server addition in the command menu', () => {
    expect(COMMANDS.find((command) => command.name === 'mcp')?.args).toContain('add')
    expect(names('/mcp ')).toEqual([
      'mcp add',
      'mcp list',
      'mcp delete',
      'mcp enable',
      'mcp disable',
    ])
    expect(names('/mcp a')).toEqual(['mcp add'])
    expect(names('/mcp d')).toEqual(['mcp delete', 'mcp disable'])
  })

  it('offers the guarded delete-all session command', () => {
    expect(names('/sessions delete a')).toEqual(['sessions delete all'])
  })

  it('ignores plain text', () => {
    expect(matchCommands('hello')).toEqual([])
  })
})

describe('commands that may run during a turn', () => {
  it('lets read-only and settings commands run while the agent is busy', () => {
    for (const name of ['help', 'usage', 'context', 'model', 'effort', 'theme', 'lang', 'budget', 'subagents', 'config', 'checker', 'quit']) {
      expect(commandRunsWhileBusy(name), `/${name} should run while busy`).toBe(true)
    }
  })

  it('keeps commands that touch the running turn or the session on the queue', () => {
    for (const name of ['clear', 'compact', 'resume', 'undo', 'login', 'provider', 'logout', 'key', 'refresh', 'mcp', 'sessions']) {
      expect(commandRunsWhileBusy(name), `/${name} should wait for the turn`).toBe(false)
    }
  })

  it('does not invent a command that is not registered', () => {
    expect(commandRunsWhileBusy('nonsense')).toBe(false)
    expect(commandRunsWhileBusy(undefined)).toBe(false)
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

  it('normalises typed colours and rejects anything else', () => {
    expect(parseAccent('#FF8800')).toBe('#ff8800')
    expect(parseAccent('ff8800')).toBe('#ff8800')
    expect(parseAccent('#f80')).toBe('#ff8800')
    expect(parseAccent(' Green ')).toBe('green')
    expect(resolveAccent('#f80')).toBe('#ff8800')
    expect(parseAccent('blu')).toBeUndefined()
    expect(parseAccent('#12')).toBeUndefined()
    expect(parseAccent('#gggggg')).toBeUndefined()
    expect(parseAccent('constructor')).toBeUndefined()
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
