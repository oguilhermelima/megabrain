// A list read again and again in the background. Each read is numbered when it starts; an answer
// older than one already settled is dropped, and a failed read keeps the last good value, so a slow
// or failing call never empties what the person sees.

export interface LatestLoad<T> {
  /** The last good value; null until the first read succeeds. */
  value: T | null
  /** The last read's error, cleared by the next success. */
  error: unknown
  /** Failed reads in a row. */
  failures: number
  /** The newest read settled so far. */
  settled: number
}

export type LoadResult<T> = { seq: number; ok: true; value: T } | { seq: number; ok: false; error: unknown }

export const initialLoad: LatestLoad<never> = { value: null, error: null, failures: 0, settled: 0 }

export function settleLoad<T>(state: LatestLoad<T>, result: LoadResult<T>): LatestLoad<T> {
  if (result.seq <= state.settled) return state
  if (result.ok) return { value: result.value, error: null, failures: 0, settled: result.seq }
  return { ...state, error: result.error, failures: state.failures + 1, settled: result.seq }
}

/** Numbers reads as they start; only the newest one started may write its answer. */
export function readFence(): { start: () => number; newest: (read: number) => boolean } {
  let last = 0
  return { start: () => ++last, newest: (read) => read === last }
}
