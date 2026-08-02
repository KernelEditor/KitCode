import { useInput, usePaste } from 'ink'
import type { Key } from 'ink'
import { useRef } from 'react'

export type TerminalInputHandler = (input: string, key: Key) => void

/**
 * Ink 7's useInput currently retains the first callback closure with this
 * React version. Route events through a stable ref so handlers always see the
 * latest state, props, command matches, and overlay.
 */
export function useTerminalInput(
  handler: TerminalInputHandler,
  options: { isActive?: boolean } = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useInput((input, key) => {
    // Kitty keyboard protocol may report both press and release events.
    if (key.eventType === 'release') return
    handlerRef.current(input, key)
  }, options)
}

/** Keep paste handlers fresh for the same reason as useTerminalInput. */
export function useTerminalPaste(
  handler: (text: string) => void,
  options: { isActive?: boolean } = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  usePaste((text) => handlerRef.current(text), options)
}
