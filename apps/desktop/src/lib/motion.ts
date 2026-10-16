// The app's motion, measured in the CSS tokens of styles.css (:root --motion-*). The code reads the
// same tokens, so a duration lives in one place and prefers-reduced-motion, which sets them to 0ms,
// turns off the waits here too.

export type MotionToken = '--motion-enter' | '--motion-exit' | '--motion-panel'

/** A CSS time ('160ms', '0.16s') in milliseconds; anything else is 0, so a missing token never holds anything on screen. */
export function motionMs(value: string): number {
  const match = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(value)
  if (match === null) return 0
  const amount = Number(match[1])
  return match[2] === 's' ? amount * 1000 : amount
}

/** How long a motion token lasts, read from the document. */
export function tokenMs(token: MotionToken): number {
  if (typeof document === 'undefined') return 0
  return motionMs(getComputedStyle(document.documentElement).getPropertyValue(token))
}

export interface Presence<T> {
  /** What to render: the value, or while it leaves the last one it had. */
  shown: T | null
  /** Closed but still on screen while its exit plays; it takes no input then. */
  leaving: boolean
}

/**
 * What stays on screen for `value`, given the last value shown (`last`, null once an exit has
 * finished). A value that goes away keeps rendering as leaving until its exit is done.
 */
export function presence<T>(value: T | null, last: T | null): Presence<T> {
  if (value !== null) return { shown: value, leaving: false }
  if (last !== null) return { shown: last, leaving: true }
  return { shown: null, leaving: false }
}
