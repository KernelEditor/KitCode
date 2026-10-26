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

// Fixed, conservative estimate of the prompt + status bar + slack. A measured
// value used to cause a visible jump when the real height was discovered after
// the first frame; a constant never moves, so the chrome never jumps.
// Prompt (up to 6 input rows + 2 borders + margin + hint) + status bar (3)
// + queue/autocomplete allowance (4) = 16.
const CHROME_ROWS = 16
const MAX_LIVE_ROWS = 11
const MIN_LIVE_ROWS = 4
// Free rows between the frame and the bottom of the terminal: Ink's trailing
// newline plus one row of slack so a frame never reaches the bottom edge and
// flips Ink into fullscreen repaint mode (which on Windows clears the whole
// terminal and replays the chat for a frame).
const BOTTOM_SLACK_ROWS = 3

export function liveTranscriptRows(rows: number, chromeRows?: number): number {
  if (!Number.isFinite(rows)) return MAX_LIVE_ROWS
  const chrome = chromeRows ?? CHROME_ROWS
  // Strictly below the terminal: one extra row of margin so the equality case
  // (live + chrome + slack === rows) never occurs.
  const budget = Math.floor(rows) - chrome - BOTTOM_SLACK_ROWS - 1
  return Math.max(MIN_LIVE_ROWS, Math.min(MAX_LIVE_ROWS, budget))
}

/**
 * Keep Ink's changing output plus its trailing newline below the terminal's
 * full height. Reaching the bottom-right cell scrolls Windows consoles and
 * leaves incremental redraws at the wrong cursor position.
 */
export function TerminalViewport({ children, rows }: { children: ReactNode; rows: number }) {
  const { columns } = useTerminalSize()
  const liveRows = liveTranscriptRows(rows)
  const items = Array.isArray(children) ? children : [children]
  const [transcript, ...chromeChildren] = items
  return (
    <Box
      width={columns - 1} maxWidth="100%"
      flexDirection="column"
      maxHeight={liveRows + CHROME_ROWS}
      overflowY="hidden"
    >
      <Box
        flexDirection="column"
        flexShrink={1}
        minHeight={0}
        maxHeight={liveRows}
        overflowY="hidden"
      >
        {transcript}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {chromeChildren}
      </Box>
    </Box>
  )
}
