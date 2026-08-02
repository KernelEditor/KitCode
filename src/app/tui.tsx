import { render } from 'ink'
import { App } from '../ui/App'
import type { AgentMode } from '../tools/permissions'
import { boot } from './runtime'

function clearTerminal(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
}

export async function startTui(options: {
  continueSession?: boolean
  resumeId?: string
  cwd?: string
  modelRef?: string
  mode?: AgentMode
}): Promise<void> {
  const { runtime, history, warnings, shutdown } = await boot({
    cwd: options.cwd ?? process.cwd(),
    continueSession: options.continueSession,
    resumeId: options.resumeId,
    modelRef: options.modelRef,
    mode: options.mode,
  })

  clearTerminal()

  const instance = render(<App runtime={runtime} initialHistory={history} warnings={warnings} />, {
    // Only rewrite terminal lines that actually changed. Combined with the UI's
    // stream batching this keeps long code responses responsive without
    // sacrificing the normal terminal scrollback.
    incrementalRendering: true,
    maxFps: 30,
  })
  try {
    await instance.waitUntilExit()
  } finally {
    await shutdown()
  }
}
