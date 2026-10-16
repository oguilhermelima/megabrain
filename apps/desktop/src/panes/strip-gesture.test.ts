import { describe, expect, test } from 'bun:test'
import type { PaneLeaf } from '@/panes/pane-model'
import { presetTree } from '@/panes/split-groups'
import { emptyStrip, stripLayout } from '@/panes/strip'
import { follow, gestureGap, revealAllowed, revealQuiet, snapTarget, snapTolerance, wheelStep, type Gesture, type Wheel } from '@/panes/strip-gesture'

const leaf = (item: string): PaneLeaf => ({ type: 'pane', id: `p-${item}`, item })
const leaves = (count: number) => Array.from({ length: count }, (_, index) => leaf(`i${index + 1}`))

/** A 14-inch MacBook Pro's pane area holding six columns side by side: three show, each 504px wide. */
const view = { width: 1512, height: 982 }
const layout = stripLayout(presetTree(leaves(6), 'row', 'g'), emptyStrip, view)
const max = layout.width - view.width

const frame = 1000 / 60
const wheel = (deltaX: number, deltaY: number, time: number, extra: Partial<Wheel> = {}): Wheel => ({ deltaX, deltaY, deltaMode: 0, shiftKey: false, time, ...extra })

/** A two-finger swipe at 60 Hz: fractional sideways steps that slow down, with the vertical jitter a real hand adds (larger than the sideways step in the tail). */
function trackpadSwipe(start: number, direction: 1 | -1, steps = 48): Wheel[] {
  return Array.from({ length: steps }, (_, index) => {
    const deltaX = direction * Math.max(0.3, 14 * Math.exp(-index / 12))
    const deltaY = index % 3 === 0 ? 0.9 : index % 3 === 1 ? -0.6 : 0
    return wheel(deltaX, deltaY, start + index * frame)
  })
}

/**
 * Plays wheel events on a strip whose element keeps whole pixels only, the way a scroll container
 * rounds scrollLeft, and returns every scrollLeft the person sees plus where the snap leaves it.
 */
function play(events: Wheel[], options: { from?: number; innerScrollsX?: (deltaX: number) => boolean; onEvent?: (gesture: Gesture | null, wheel: Wheel) => void } = {}) {
  let gesture: Gesture | null = null
  let position: number | null = null
  let scrollLeft = options.from ?? 0
  const seen: number[] = []
  let asked = 0
  for (const event of events) {
    const step = wheelStep(gesture, event, view.width, (deltaX) => {
      asked += 1
      return options.innerScrollsX?.(deltaX) ?? false
    })
    gesture = step.gesture
    if (step.strip !== null) {
      position = follow(position, scrollLeft, step.strip, max)
      scrollLeft = Math.round(position)
    }
    options.onEvent?.(gesture, event)
    seen.push(scrollLeft)
  }
  const snapped = gesture?.moved === true ? snapTarget(layout, scrollLeft, view.width) : null
  return { seen, final: scrollLeft, snapped, gesture, asked }
}

const monotonic = (values: number[], direction: 1 | -1) => values.every((value, index) => index === 0 || (value - (values[index - 1] ?? value)) * direction >= 0)
const sum = (events: Wheel[]) => events.reduce((total, event) => total + event.deltaX, 0)

describe('a sideways gesture moves the strip', () => {
  test('a trackpad swipe follows its deltas exactly and never steps back, vertical jitter included', () => {
    const events = trackpadSwipe(1000, 1)
    const { seen, final } = play(events)
    expect(monotonic(seen, 1)).toBe(true)
    expect(Math.abs(final - sum(events))).toBeLessThanOrEqual(1)
  })

  test('the jitter events where vertical outweighs sideways still belong to the strip, so nothing inside scrolls up and down', () => {
    let gesture: Gesture | null = null
    const strips: (number | null)[] = []
    for (const event of [wheel(6, 1, 0), wheel(0.4, 1.2, frame), wheel(0, 2, 2 * frame)]) {
      const step = wheelStep(gesture, event, view.width, () => false)
      gesture = step.gesture
      strips.push(step.strip)
    }
    expect(strips).toEqual([6, 0.4, 0])
  })

  test('back the other way, from the far end', () => {
    const events = trackpadSwipe(1000, -1)
    const { seen, final } = play(events, { from: max })
    expect(monotonic(seen, -1)).toBe(true)
    expect(Math.abs(max - final - Math.abs(sum(events)))).toBeLessThanOrEqual(1)
  })

  test('mouse-like notches move by their whole size; line deltas count as lines', () => {
    const notches = [0, 1, 2, 3].map((index) => wheel(120, 0, index * 80))
    const { seen, final } = play(notches)
    expect(seen).toEqual([120, 240, 360, 480])
    expect(final).toBe(480)
    const lines = wheelStep(null, wheel(3, 0, 0, { deltaMode: 1 }), view.width, () => false)
    expect(lines.strip).toBe(120)
    const pages = wheelStep(null, wheel(1, 0, 0, { deltaMode: 2 }), view.width, () => false)
    expect(pages.strip).toBe(view.width)
  })

  test('fractional steps add up even though the element keeps whole pixels', () => {
    const events = Array.from({ length: 60 }, (_, index) => wheel(0.4, 0, index * frame))
    const { seen, final } = play(events)
    expect(final).toBe(24)
    expect(monotonic(seen, 1)).toBe(true)
  })

  test('the strip stops at its ends', () => {
    expect(play([wheel(-50, 0, 0)]).final).toBe(0)
    expect(play([wheel(500, 0, 0)], { from: max - 100 }).final).toBe(max)
  })
})

describe('shift with a wheel', () => {
  test('a vertical wheel with shift scrolls sideways', () => {
    expect(wheelStep(null, wheel(0, 40, 0, { shiftKey: true }), view.width, () => false).strip).toBe(40)
    expect(wheelStep(null, wheel(0, -40, 0, { shiftKey: true }), view.width, () => false).strip).toBe(-40)
  })

  test('a sideways delta the platform already turned is taken once, never twice', () => {
    expect(wheelStep(null, wheel(40, 0, 0, { shiftKey: true }), view.width, () => false).strip).toBe(40)
    expect(wheelStep(null, wheel(30, 2, 0, { shiftKey: true }), view.width, () => false).strip).toBe(30)
  })
})

describe('a vertical gesture leaves the strip alone', () => {
  test('every event of it, even one that leans sideways', () => {
    let gesture: Gesture | null = null
    const strips: (number | null)[] = []
    for (const event of [wheel(0.5, 8, 0), wheel(3, 2, frame), wheel(0, 4, 2 * frame)]) {
      const step = wheelStep(gesture, event, view.width, () => false)
      gesture = step.gesture
      strips.push(step.strip)
    }
    expect(strips).toEqual([null, null, null])
    expect(gesture?.axis).toBe('y')
  })

  test('a pause starts a new gesture, which may go sideways', () => {
    const first = wheelStep(null, wheel(0, 8, 0), view.width, () => false)
    const soon = wheelStep(first.gesture, wheel(8, 0, gestureGap - 1), view.width, () => false)
    expect(soon.strip).toBeNull()
    const later = wheelStep(soon.gesture, wheel(8, 0, 2 * gestureGap + 10), view.width, () => false)
    expect(later.strip).toBe(8)
  })

  test('an event with no delta changes nothing', () => {
    const step = wheelStep(null, wheel(0, 0, 0), view.width, () => false)
    expect(step).toEqual({ gesture: null, strip: null })
  })
})

describe('an inner element that scrolls sideways goes first', () => {
  test('it owns the whole gesture, and is asked once, when the gesture starts', () => {
    const { seen, asked, gesture } = play(trackpadSwipe(0, 1), { innerScrollsX: () => true })
    expect(seen.every((value) => value === 0)).toBe(true)
    expect(asked).toBe(1)
    expect(gesture?.strip).toBe(false)
  })

  test('it is asked with the direction of the swipe', () => {
    const directions: number[] = []
    play(trackpadSwipe(0, -1), { from: 500, innerScrollsX: (deltaX) => (directions.push(Math.sign(deltaX)), false) })
    expect(directions).toEqual([-1])
  })

  test('the next gesture asks again', () => {
    let calls = 0
    const inner = () => (calls += 1) === 1
    const first = wheelStep(null, wheel(6, 0, 0), view.width, inner)
    expect(first.strip).toBeNull()
    const next = wheelStep(first.gesture, wheel(6, 0, gestureGap + 50), view.width, inner)
    expect(next.strip).toBe(6)
  })
})

describe('no reveal while the person scrolls', () => {
  test('a focus change mid-gesture does not pull the strip back', () => {
    const events = trackpadSwipe(5000, 1)
    const allowed: boolean[] = []
    const { seen } = play(events, { onEvent: (gesture, event) => allowed.push(revealAllowed(gesture, event.time + frame / 2)) })
    expect(allowed.every((value) => !value)).toBe(true)
    expect(monotonic(seen, 1)).toBe(true)
  })

  test('the reveal comes back once the strip has rested', () => {
    const step = wheelStep(null, wheel(10, 0, 1000), view.width, () => false)
    expect(revealAllowed(step.gesture, 1000 + revealQuiet - 1)).toBe(false)
    expect(revealAllowed(step.gesture, 1000 + revealQuiet)).toBe(true)
    expect(revealAllowed(null, 0)).toBe(true)
  })

  test('a vertical gesture inside a pane does not hold the reveal back', () => {
    const step = wheelStep(null, wheel(0, 10, 1000), view.width, () => false)
    expect(revealAllowed(step.gesture, 1001)).toBe(true)
  })
})

describe('the snap once the gesture ends', () => {
  test('a column edge a few pixels away is where the strip settles', () => {
    expect(snapTarget(layout, 504 + 10, view.width)).toBe(504)
    expect(snapTarget(layout, 504 - 10, view.width)).toBe(504)
    expect(snapTarget(layout, max - 5, view.width)).toBe(max)
    expect(snapTarget(layout, 6, view.width)).toBe(0)
  })

  test('far from any edge, or already on one, nothing moves', () => {
    expect(snapTarget(layout, 504 + snapTolerance + 1, view.width)).toBeNull()
    expect(snapTarget(layout, 756, view.width)).toBeNull()
    expect(snapTarget(layout, 504, view.width)).toBeNull()
  })

  test('a swipe ends where its deltas say, within the snap tolerance', () => {
    for (const steps of [20, 30, 48, 64]) {
      const events = trackpadSwipe(0, 1, steps)
      const { final, snapped } = play(events)
      const resting = snapped ?? final
      expect(Math.abs(resting - sum(events))).toBeLessThanOrEqual(snapTolerance + 1)
    }
  })

  test('a gesture that never moved the strip does not snap', () => {
    const { snapped } = play(trackpadSwipe(0, 1), { from: 510, innerScrollsX: () => true })
    expect(snapped).toBeNull()
  })
})

describe('following the strip', () => {
  test('a scroll set elsewhere (a reveal, the minimap) is where the next step starts', () => {
    expect(follow(100.4, 300, 5, max)).toBe(305)
    expect(follow(100.4, 100, 0.4, max)).toBeCloseTo(100.8, 6)
    expect(follow(null, 42, 1.5, max)).toBe(43.5)
  })

  test('kept between the ends', () => {
    expect(follow(2, 2, -10, max)).toBe(0)
    expect(follow(max - 1, max - 1, 10, max)).toBe(max)
  })
})
