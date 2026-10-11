import { useTerminalSize } from '../terminal-size'
import { Box } from 'ink'
import type { ReactNode } from 'react'

export function interactiveViewportRows(rows: number): number {
  if (!Number.isFinite(rows)) return 22
  // Ink appends a newline after every non-fullscreen interactive frame. Keep
  // another row free so that newline cannot scroll the Windows console and
  // desynchronize subsequent incremental cursor updates.
  return Math.max(1, Math.floor(rows) - 2)
}

const INTERACTIVE_CHROME_ROWS = 14
const MAX_LIVE_ROWS = 8
const MIN_LIVE_ROWS = 4

export function liveTranscriptRows(rows: number): number {
  if (!Number.isFinite(rows)) return MAX_LIVE_ROWS
  // Fixed band, and always at least two rows below the terminal: a frame at or
  // above the terminal height flips Ink into full-clear reprint mode on
  // Windows, which replays the whole chat history on every streamed frame.
  return Math.max(MIN_LIVE_ROWS, Math.min(MAX_LIVE_ROWS, Math.floor(rows) - INTERACTIVE_CHROME_ROWS - 2))
}

/**
 * Keep Ink's changing output plus its trailing newline below the terminal's
 * full height. Reaching the bottom-right cell scrolls Windows consoles and
 * leaves incremental redraws at the wrong cursor position.
 */
export function TerminalViewport({ children, rows }: { children: ReactNode; rows: number }) {
  const { columns } = useTerminalSize()
  return (
    <Box
      width={columns} maxWidth="100%"
      flexDirection="column"
      maxHeight={liveTranscriptRows(rows) + INTERACTIVE_CHROME_ROWS}
      overflowY="hidden"
    >
      {children}
    </Box>
  )
}
