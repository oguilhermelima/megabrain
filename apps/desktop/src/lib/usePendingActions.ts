import { useRef, useState } from 'react'
import { beginPending, failPending, settlePending, type PendingMap } from '@/lib/pending-model'

/**
 * Runs actions that start something, one at a time per trigger (pending-model.ts). A second call for
 * a trigger that still runs is dropped, even before React renders the first. A failed one keeps its
 * error until `retry` runs the same task again or `dismiss` lets it go.
 */
export function usePendingActions() {
  const [pending, setPending] = useState<PendingMap>({})
  const running = useRef(new Set<string>())
  const tasks = useRef(new Map<string, { label: string; task: () => Promise<void> }>())

  const run = async (key: string, label: string, task: () => Promise<void>): Promise<boolean> => {
    if (running.current.has(key)) return false
    running.current.add(key)
    tasks.current.set(key, { label, task })
    setPending((current) => beginPending(current, key, label) ?? current)
    try {
      await task()
      tasks.current.delete(key)
      setPending((current) => settlePending(current, key))
      return true
    } catch (caught) {
      setPending((current) => failPending(current, key, caught))
      return false
    } finally {
      running.current.delete(key)
    }
  }

  return {
    pending,
    run,
    retry: (key: string) => {
      const stored = tasks.current.get(key)
      return stored === undefined ? Promise.resolve(false) : run(key, stored.label, stored.task)
    },
    dismiss: (key: string) => {
      if (running.current.has(key)) return
      tasks.current.delete(key)
      setPending((current) => settlePending(current, key))
    },
  }
}
