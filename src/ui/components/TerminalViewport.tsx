import { Box } from 'ink'
import type { ReactNode } from 'react'

export function interactiveViewportRows(rows: number): number {
  if (!Number.isFinite(rows)) return 22
  // Ink appends a newline after every non-fullscreen interactive frame. Keep
  // another row free so that newline cannot scroll the Windows console and
  // desynchronize subsequent incremental cursor updates.
  return Math.max(1, Math.floor(rows) - 2)
}

/**
 * Keep Ink's changing output plus its trailing newline below the terminal's
 * full height. Reaching the bottom-right cell scrolls Windows consoles and
 * leaves incremental redraws at the wrong cursor position.
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
