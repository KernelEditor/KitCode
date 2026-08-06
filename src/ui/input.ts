import { useInput, usePaste } from 'ink'
import type { Key } from 'ink'
import { useRef } from 'react'

export type TerminalInputHandler = (input: string, key: Key) => void

export function useTerminalInput(
  handler: TerminalInputHandler,
  options: { isActive?: boolean } = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useInput((input, key) => {
    
    if (key.eventType === 'release') return
    handlerRef.current(input, key)
  }, options)
}

export function useTerminalPaste(
  handler: (text: string) => void,
  options: { isActive?: boolean } = {},
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  usePaste((text) => handlerRef.current(text), options)
}
