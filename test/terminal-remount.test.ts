import { describe, expect, it } from 'vitest'
import { liveTranscriptRows } from '../src/ui/components/TerminalViewport'

describe('live transcript row budget', () => {
  it('stays within a fixed band across terminal heights', () => {
    expect(liveTranscriptRows(Number.NaN)).toBe(8)
    // Fixed band 4..8; NaN falls back to the cap.
    expect(liveTranscriptRows(24)).toBe(8)
    expect(liveTranscriptRows(30)).toBe(8)
    expect(liveTranscriptRows(60)).toBe(8)
    expect(liveTranscriptRows(20)).toBe(4)
    expect(liveTranscriptRows(16)).toBe(4)
  })

  it('keeps the full frame strictly below the terminal height', () => {
    // live + 14 rows of chrome + Ink's trailing newline must stay below rows,
    // or Windows flips Ink into full-clear reprint mode and replays the chat.
    // Below 20 rows the chrome itself does not fit; treat that as unsupported.
    for (const rows of [20, 24, 30, 40, 50, 60, 100]) {
      expect(liveTranscriptRows(rows) + 14 + 1).toBeLessThan(rows)
    }
  })
})
