import { horizontalWheel, type StripLayout } from '@/panes/strip'

// A wheel or two-finger swipe over the strip, as one gesture: its first event decides whether it goes
// sideways or up and down, and who owns it, and that holds until the wheel rests. A sideways gesture
// belongs to the strip (unless something under the pointer scrolls sideways itself, which then goes
// first, like the browser's own latching), so the vertical jitter of a real hand never reaches a
// terminal or a column, and the strip follows the deltas exactly. While a gesture runs, and a moment
// after, nothing pulls the strip to the focused pane. Every function here is pure; useStripScroll applies it.

/** A pause longer than this between wheel events ends the gesture, in ms. */
export const gestureGap = 150

/** How long after the last sideways wheel event the focused pane may slide into view again, in ms. */
export const revealQuiet = 300

/** How near a column edge the strip has to rest for it to settle on that edge, in px. */
export const snapTolerance = 12

/** Pixels per line for a wheel that counts in lines. */
const lineHeight = 40

export interface Wheel {
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  deltaMode: number
  shiftKey: boolean
  /** When it came, in ms. */
  time: number
}

export interface Gesture {
  axis: 'x' | 'y'
  /** The strip owns it: a sideways gesture with nothing under the pointer that scrolls sideways. */
  strip: boolean
  /** When its last event came, in ms. */
  last: number
  /** It has moved the strip. */
  moved: boolean
}

/** The sideways and vertical parts of an event: a mostly vertical wheel with shift is sideways. */
function parts(wheel: Wheel, page: number): { x: number; y: number } {
  const unit = wheel.deltaMode === 1 ? lineHeight : wheel.deltaMode === 2 ? page : 1
  const shifted = horizontalWheel(wheel)
  if (shifted !== 0) return { x: shifted * unit, y: 0 }
  return { x: wheel.deltaX * unit, y: wheel.deltaY * unit }
}

/**
 * One wheel event of `gesture` (null when none runs). `strip` is how far it moves the strip, in px,
 * or null when the event is left to the platform and the panes. A number, zero included, means the
 * event is the strip's: nothing else may handle it. `innerScrollsX` says whether something under the
 * pointer can scroll that way itself; it is asked only when a sideways gesture starts.
 */
export function wheelStep(gesture: Gesture | null, wheel: Wheel, page: number, innerScrollsX: (deltaX: number) => boolean): { gesture: Gesture | null; strip: number | null } {
  const { x, y } = parts(wheel, page)
  if (x === 0 && y === 0) return { gesture, strip: null }
  let current: Gesture
  if (gesture === null || wheel.time - gesture.last > gestureGap) {
    const axis = Math.abs(x) > Math.abs(y) ? 'x' : 'y'
    current = { axis, strip: axis === 'x' && !innerScrollsX(x), last: wheel.time, moved: false }
  } else current = { ...gesture, last: wheel.time }
  if (!current.strip) return { gesture: current, strip: null }
  if (x !== 0) current.moved = true
  return { gesture: current, strip: x }
}

/** Whether the focused pane may be scrolled into view at `now`: not while a sideways gesture runs, nor just after. */
export function revealAllowed(gesture: Gesture | null, now: number): boolean {
  return gesture === null || gesture.axis !== 'x' || now - gesture.last >= revealQuiet
}

/**
 * Where a strip resting at `scroll` settles: a column's left edge on the view's left, or its right
 * edge on the view's right, when one lies within snapTolerance. Null when it is already on one or
 * none is near.
 */
export function snapTarget(layout: StripLayout, scroll: number, view: number): number | null {
  const end = Math.max(0, layout.width - view)
  let best: number | null = null
  for (const column of layout.columns) {
    for (const stop of [column.x, column.x + column.width - view]) {
      const at = Math.max(0, Math.min(end, stop))
      if (best === null || Math.abs(at - scroll) < Math.abs(best - scroll)) best = at
    }
  }
  if (best === null) return null
  const distance = Math.abs(best - scroll)
  return distance < 0.5 || distance > snapTolerance ? null : best
}

/**
 * The strip's position after a step of `delta`, kept to the fraction: an element holds whole pixels,
 * so small trackpad steps would be lost were each added to its scrollLeft. `position` is the last one
 * set; when `actual` has moved away from it (a reveal, the minimap, the platform), the step starts there.
 */
export function follow(position: number | null, actual: number, delta: number, max: number): number {
  const from = position !== null && Math.abs(position - actual) < 1 ? position : actual
  return Math.max(0, Math.min(max, from + delta))
}
