import { describe, expect, it } from 'vitest'
import { liveTranscriptRows } from '../src/ui/components/TerminalViewport'

describe('live transcript row budget', () => {
  it('stays within a fixed band across terminal heights', () => {
    expect(liveTranscriptRows(Number.NaN)).toBe(11)
    // Fixed band 4..11; NaN falls back to the cap. With the default chrome
    // estimate (16) and bottom slack (3 + 1 of margin) a 24-row terminal
    // leaves 4 rows for the live transcript.
    expect(liveTranscriptRows(24)).toBe(4)
    expect(liveTranscriptRows(30)).toBe(10)
    expect(liveTranscriptRows(60)).toBe(11)
    expect(liveTranscriptRows(20)).toBe(4)
    expect(liveTranscriptRows(16)).toBe(4)
  })

  it('keeps the full frame strictly below the terminal height', () => {
    // live + chrome estimate + bottom slack must stay below rows, or Windows
    // flips Ink into full-clear reprint mode and replays the chat. Holds once
    // the terminal fits the chrome plus the minimum live band (>= 24 rows).
    for (const rows of [24, 30, 40, 50, 60, 100]) {
      expect(liveTranscriptRows(rows) + 16 + 3).toBeLessThan(rows)
    }
  })
})
