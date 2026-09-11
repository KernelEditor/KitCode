import { useStdout } from 'ink'
import { useMemo, useSyncExternalStore } from 'react'

type Size = { columns: number; rows: number }

const stores = new WeakMap<NodeJS.WriteStream, ReturnType<typeof createStore>>()

function createStore(stdout: NodeJS.WriteStream) {
  let size: Size = { columns: stdout.columns || 80, rows: stdout.rows || 24 }
  const listeners = new Set<() => void>()
  const update = () => {
    const columns = stdout.columns || 80
    const rows = stdout.rows || 24
    if (columns === size.columns && rows === size.rows) return
    size = { columns, rows }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => size,
    subscribe(listener: () => void) {
      if (listeners.size === 0) stdout.on('resize', update)
      listeners.add(listener)
      update()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stdout.off('resize', update)
      }
    },
  }
}

export function useTerminalSize(): Size {
  const { stdout } = useStdout()
  const store = useMemo(() => {
    let current = stores.get(stdout)
    if (!current) {
      current = createStore(stdout)
      stores.set(stdout, current)
    }
    return current
  }, [stdout])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
