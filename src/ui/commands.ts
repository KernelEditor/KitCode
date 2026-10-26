export interface SlashCommand {
  name: string
  args?: string
  // Left out for commands that must wait for the running turn to finish: a queued
  // message would otherwise be interleaved with work already in flight.
  runsWhileBusy?: true
}

const BUSY_SAFE = { runsWhileBusy: true } as const

export const COMMANDS: SlashCommand[] = [
  { name: 'model', args: '[model]', ...BUSY_SAFE },
  { name: 'login' },
  { name: 'provider' },
  { name: 'logout', args: '[provider]' },
  { name: 'key', args: '[provider]' },
  { name: 'refresh', args: '[provider]' },
  { name: 'effort', ...BUSY_SAFE },
  { name: 'thinking', args: '[on|off]', ...BUSY_SAFE },
  { name: 'bell', args: '[on|off]', ...BUSY_SAFE },
  { name: 'context', args: '[tokens|auto]', ...BUSY_SAFE },
  { name: 'budget', args: '[tokens]', ...BUSY_SAFE },
  { name: 'theme', args: '[color]', ...BUSY_SAFE },
  { name: 'lang', args: '[en|ru]', ...BUSY_SAFE },
  { name: 'prompt', args: '[name|save [name]|delete [name]]' },
  { name: 'skills', args: '[install <source>|remove [name]]' },
  { name: 'bypass' },
  { name: 'usage', ...BUSY_SAFE },
  { name: 'mcp', args: '[add|list|delete|enable|disable]' },
  { name: 'attach', args: '<path|clipboard|clear>' },
  { name: 'memory', args: '[show|set <text>|clear]' },
  { name: 'systemp', args: '[set <text>|clear]', ...BUSY_SAFE },
  { name: 'steps', args: '[count]', ...BUSY_SAFE },
  { name: 'compact' },
  { name: 'update' },
  { name: 'checker', ...BUSY_SAFE },
  { name: 'sessions', args: '[list|rename|delete [all]|export]' },
  { name: 'config', ...BUSY_SAFE },
  { name: 'resume' },
  { name: 'undo' },
  { name: 'clear' },
  { name: 'subagents', ...BUSY_SAFE },
  { name: 'help', ...BUSY_SAFE },
  { name: 'exit', ...BUSY_SAFE },
]

const SUBCOMMANDS: SlashCommand[] = [
  { name: 'skills install', args: '<github-url|npm-package|path>' },
  { name: 'skills remove', args: '[name]' },
  { name: 'mcp add', args: '<name> [-e K=V] [-H "N: V"] <url|-- command>' },
  { name: 'mcp list' },
  { name: 'mcp delete', args: '[name]' },
  { name: 'mcp enable', args: '[name]' },
  { name: 'mcp disable', args: '[name]' },
  { name: 'sessions list' },
  { name: 'sessions rename', args: '[id] <title>' },
  { name: 'sessions delete', args: '[id]' },
  { name: 'sessions delete all' },
  { name: 'sessions export', args: '[id] [path]' },
]

export function commandRunsWhileBusy(name: string | undefined): boolean {
  if (name === 'quit') return true
  return COMMANDS.some((command) => command.name === name && command.runsWhileBusy === true)
}

export function matchCommands(line: string): SlashCommand[] {
  if (!line.startsWith('/')) return []
  const token = line.slice(1)
  if (token.includes(' ')) {
    const needle = token.toLowerCase()
    return SUBCOMMANDS.filter((command) => command.name.startsWith(needle))
  }
  if (token === '') return COMMANDS

  const needle = token.toLowerCase()
  const starts = COMMANDS.filter((command) => command.name.startsWith(needle))
  if (starts.length > 0) return starts

  const contains = COMMANDS.filter((command) => command.name.includes(needle))
  if (contains.length > 0) return contains

  return COMMANDS.filter((command) => isSubsequence(needle, command.name))
}

export function closestCommand(name: string): SlashCommand | undefined {
  const needle = name.toLowerCase()
  let best: SlashCommand | undefined
  let bestScore = Number.POSITIVE_INFINITY

  for (const command of COMMANDS) {
    const score = editDistance(needle, command.name)
    if (score < bestScore) {
      bestScore = score
      best = command
    }
  }

  return bestScore <= Math.max(2, Math.floor(needle.length / 2)) ? best : undefined
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return needle.length === 0
}

// Optimal string alignment distance: like Levenshtein, but swapping two
// neighbouring letters ("hepl" for "help") costs one edit, not two.
function editDistance(a: string, b: string): number {
  let beforePrevious: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (beforePrevious[j - 2] ?? 0) + 1)
      }
      current[j] = best
    }
    beforePrevious = previous
    previous = current
  }

  return previous[b.length] ?? 0
}
