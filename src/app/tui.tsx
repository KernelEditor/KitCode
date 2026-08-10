import { render } from 'ink'
import type { RenderOptions } from 'ink'
import { App } from '../ui/App'
import type { AgentMode } from '../tools/permissions'
import { boot } from './runtime'

function clearTerminal(): void {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
}

export const TUI_RENDER_OPTIONS = {
  // Keep unchanged streamed lines in place instead of clearing and redrawing
  // the whole live region on every frame.
  incrementalRendering: true,
  maxFps: 30,
} satisfies RenderOptions

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

  const instance = render(
    <App runtime={runtime} initialHistory={history} warnings={warnings} />,
    TUI_RENDER_OPTIONS,
  )
  try {
    await instance.waitUntilExit()
  } finally {
    await shutdown()
  }
}
