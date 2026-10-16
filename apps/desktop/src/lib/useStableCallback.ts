import { useCallback, useRef } from 'react'

/** A function that keeps its identity across renders and always calls the latest `callback`, so memoised children given it do not re-render. */
export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback)
  latest.current = callback
  return useCallback((...args: A) => latest.current(...args), [])
}
