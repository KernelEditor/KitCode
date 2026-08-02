import { createInterface } from 'node:readline/promises'
import type { AgentHooks } from '../core/types'
import type { AgentMode } from '../tools/permissions'
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

  for (const warning of warnings) console.error(warning)

  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.on('SIGINT', onInterrupt)

  const hooks: AgentHooks = {
    onEvent(event) {
      if (event.type === 'text_delta') process.stdout.write(event.text)
      else if (event.type === 'tool_start') process.stderr.write(`\n· ${event.summary}\n`)
      else if (event.type === 'notice') process.stderr.write(`\n${event.text}\n`)
    },
    async requestPermission(request) {
      if (options.yes) return 'once'
      if (!process.stdin.isTTY) return 'deny'
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = await rl.question(`\nallow ${request.summary}? [y/N] `)
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
