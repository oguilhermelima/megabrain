import { useEffect, useReducer, useRef } from 'react'
import { presence, tokenMs, type MotionToken, type Presence } from '@/lib/motion'

/**
 * Keeps a closing dialog, menu or panel mounted until its exit has played: pass what is open (null
 * when closed) and render `shown`, marked with `leaving` while it goes. Mark the leaving element
 * inert so it takes no clicks or keys during its exit.
 */
export function usePresence<T>(value: T | null, token: MotionToken = '--motion-exit'): Presence<T> {
  const last = useRef<T | null>(null)
  if (value !== null) last.current = value
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const state = presence(value, last.current)
  useEffect(() => {
    if (!state.leaving) return
    const timer = setTimeout(() => {
      last.current = null
      rerender()
    }, tokenMs(token))
    return () => clearTimeout(timer)
  }, [state.leaving, token])
  return state
}
