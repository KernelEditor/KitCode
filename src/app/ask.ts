import { createInterface } from 'node:readline/promises'
import type { AgentHooks, PermissionRequest } from '../core/types'
import type { AgentMode } from '../tools/permissions'
import { sanitizeTerminalText } from '../ui/sanitize'
import { boot } from './runtime'

// Russian ЁЙЦУКЕН: pressing Y on a Russian layout emits `н`.
const RU_YES = new Set(['y', 'н'])

export async function ask(
  text: string,
  options: { yes?: boolean; mode?: AgentMode } = {},
): Promise<void> {
  const { runtime, history, warnings, shutdown } = await boot({
    cwd: process.cwd(),
    bypass: options.yes,
    mode: options.mode,
  })

  for (const warning of warnings) console.error(sanitizeTerminalText(warning))

  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.on('SIGINT', onInterrupt)

  const hooks: AgentHooks = {
    onEvent(event) {
      if (event.type === 'text_delta') process.stdout.write(sanitizeTerminalText(event.text))
      else if (event.type === 'tool_start') {
        process.stderr.write(`\n· ${sanitizeTerminalText(event.summary)}\n`)
      } else if (event.type === 'notice') {
        process.stderr.write(`\n${sanitizeTerminalText(event.text)}\n`)
      }
    },
    async requestPermission(request) {
      if (options.yes) return 'once'
      if (!process.stdin.isTTY) return 'deny'
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const details = permissionDetails(request)
        const answer = await rl.question(
          `\nallow ${sanitizeTerminalText(request.summary)}?${details ? `\n${details}` : ''}\n[y/N] `,
        )
        return RU_YES.has(answer.trim().toLowerCase().charAt(0)) ? 'once' : 'deny'
      } finally {
        rl.close()
      }
    },
  }

  try {
    const next = await runtime.run(
      [...history, { role: 'user', content: [{ type: 'text', text }] }],
      hooks,
      controller.signal,
    )
    await runtime.persist(next)
    process.stdout.write('\n')
    console.error(runtime.usageLine())
  } finally {
    process.off('SIGINT', onInterrupt)
    await shutdown()
  }
}

function permissionDetails(request: PermissionRequest): string {
  let text: string
  if (request.display?.kind === 'text') text = request.display.text
  else if (request.display?.kind === 'list') {
    text = [request.display.title, ...request.display.items.map((item) => `- ${item}`)].join('\n')
  } else if (request.display?.kind === 'diff') {
    text = [
      request.display.path,
      '--- current',
      request.display.before,
      '+++ proposed',
      request.display.after,
    ].join('\n')
  } else {
    try {
      text = JSON.stringify(request.input, null, 2)
    } catch {
      text = String(request.input)
    }
  }
  const safe = sanitizeTerminalText(text)
  return safe.length > 20_000 ? `${safe.slice(0, 20_000)}\n... preview truncated` : safe
}
