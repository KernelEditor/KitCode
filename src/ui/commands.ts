export interface SlashCommand {
  name: string
  args?: string
}

export const COMMANDS: SlashCommand[] = [
  { name: 'model' },
  { name: 'login' },
  { name: 'provider' },
  { name: 'logout' },
  { name: 'effort' },
  { name: 'thinking' },
  { name: 'theme', args: '[color]' },
  { name: 'lang' },
  { name: 'prompt', args: '[save <name>]' },
  { name: 'skills' },
  { name: 'bypass' },
  { name: 'usage' },
  { name: 'mcp', args: '[add|list|delete]' },
  { name: 'config' },
  { name: 'resume' },
  { name: 'undo' },
  { name: 'clear' },
  { name: 'help' },
  { name: 'exit' },
]

const SUBCOMMANDS: SlashCommand[] = [
  { name: 'mcp add', args: '<name> <url|-- command>' },
  { name: 'mcp list' },
  { name: 'mcp delete', args: '[name]' },
]

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

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
    }
    previous = current
  }

  return previous[b.length] ?? 0
}
