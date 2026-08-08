import { Box } from 'ink'
import type { ReactNode } from 'react'

export function interactiveViewportRows(rows: number): number {
  if (!Number.isFinite(rows)) return 23
  return Math.max(1, Math.floor(rows) - 1)
}

/**
 * Keep Ink's changing output below the terminal's full height. Fullscreen
 * frames may be cleared on redraw by terminals on both Windows and Unix,
 * which resets the user's scrollback position while a response is streaming.
 */
export function TerminalViewport({ children, rows }: { children: ReactNode; rows: number }) {
  return (
    <Box
      flexDirection="column"
      maxHeight={interactiveViewportRows(rows)}
      overflowY="hidden"
    >
      {children}
    </Box>
  )
}
