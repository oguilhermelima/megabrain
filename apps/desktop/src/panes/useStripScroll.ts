import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStableCallback } from '@/lib/useStableCallback'
import type { PaneNode } from '@/panes/pane-model'
import { panelMotion } from '@/panes/scroll-motion'
import { revealPane, stripLayout, type Strip, type StripColumn, type StripLayout } from '@/panes/strip'
import { follow, gestureGap, revealAllowed, snapTarget, wheelStep, type Gesture } from '@/panes/strip-gesture'

// How the strip of columns scrolls. A sideways wheel or two-finger swipe is one gesture
// (panes/strip-gesture): the strip takes it before anything inside sees it and follows its deltas,
// unless something under the pointer scrolls sideways itself; once it rests, the strip settles on a
// column edge a few pixels away. A column taller than the area scrolls by an offset of its own (its
// panes stay siblings of every other pane, so moving one never remounts it): a vertical wheel moves
// it once nothing under the pointer can scroll that way any more.

/** How long the strip rests before its scroll is saved with the group. */
const saveDelay = 200

/** Whether something between `from` and `stop` can still scroll by `deltaY`, so the wheel is its. */
function innerScrolls(from: Element | null, stop: Element, deltaY: number): boolean {
  for (let element = from; element !== null && element !== stop; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY
    if ((overflow !== 'auto' && overflow !== 'scroll') || element.scrollHeight <= element.clientHeight + 1) continue
    if (deltaY > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0) return true
  }
  return false
}

/** Whether something between `from` and `stop` can still scroll sideways by `deltaX`, so the gesture is its. */
function innerScrollsX(from: Element | null, stop: Element, deltaX: number): boolean {
  for (let element = from; element !== null && element !== stop; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowX
    if ((overflow !== 'auto' && overflow !== 'scroll') || element.scrollWidth <= element.clientWidth + 1) continue
    if (deltaX > 0 ? element.scrollLeft + element.clientWidth < element.scrollWidth - 1 : element.scrollLeft > 0) return true
  }
  return false
}

export interface StripScroll {
  area: React.RefObject<HTMLDivElement | null>
  scroller: React.RefObject<HTMLDivElement | null>
  size: { width: number; height: number }
  layout: StripLayout
  /** How far a column's content is scrolled, kept inside it. */
  offsetOf: (column: StripColumn) => number
  /** Scrolls the strip to `x`, with the panel motion. */
  scrollTo: (x: number) => void
}

export function useStripScroll({
  root,
  focused,
  strip,
  stripKey,
  onStrip,
  onOverflow,
}: {
  root: PaneNode
  focused: string
  strip: Strip
  /** The group the strip belongs to; a new key restores its scroll. */
  stripKey: string | null
  onStrip: ((change: (strip: Strip) => Strip) => void) | null
  onOverflow?: (scrolls: boolean) => void
}): StripScroll {
  const area = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = area.current
    if (element === null) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize((previous) => (previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => stripLayout(root, strip, size), [root, strip, size])
  const [columnScroll, setColumnScroll] = useState<Readonly<Record<string, number>>>({})
  const offsetOf = (column: StripColumn) => Math.max(0, Math.min(column.height - size.height, columnScroll[column.id] ?? 0))
  const latest = useRef({ layout, size, columnScroll, onStrip })
  latest.current = { layout, size, columnScroll, onStrip }

  const setColumn = (columnId: string, value: number) =>
    setColumnScroll((current) => {
      const column = latest.current.layout.columns.find((candidate) => candidate.id === columnId)
      const clamped = column === undefined ? 0 : Math.max(0, Math.min(column.height - latest.current.size.height, value))
      return (current[columnId] ?? 0) === clamped ? current : { ...current, [columnId]: clamped }
    })

  // One motion at a time: a new one starts from wherever the last one got to.
  const frame = useRef<number | null>(null)
  const move = useStableCallback((target: { x: number; columnId?: string; y?: number }, animate: boolean) => {
    const element = scroller.current
    if (element === null) return
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const fromX = element.scrollLeft
    const fromY = target.columnId === undefined ? 0 : (latest.current.columnScroll[target.columnId] ?? 0)
    const apply = (progress: number) => {
      element.scrollLeft = fromX + (target.x - fromX) * progress
      if (target.columnId !== undefined && target.y !== undefined) setColumn(target.columnId, fromY + (target.y - fromY) * progress)
    }
    const motion = animate ? panelMotion() : null
    if (motion === null || motion.ms <= 0 || (Math.abs(target.x - fromX) < 1 && Math.abs((target.y ?? fromY) - fromY) < 1)) {
      apply(1)
      return
    }
    const start = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / motion.ms)
      apply(motion.ease(progress))
      frame.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    frame.current = requestAnimationFrame(step)
  })
  useEffect(() => () => (frame.current === null ? undefined : cancelAnimationFrame(frame.current)), [])

  // The wheel gesture under way, if any; while it runs the person moves the strip, not the focus.
  const gesture = useRef<Gesture | null>(null)

  const reveal = (animate: boolean, columns: Readonly<Record<string, number>>) => {
    const element = scroller.current
    if (element === null || !revealAllowed(gesture.current, performance.now())) return
    const target = revealPane(latest.current.layout, focused, { scroll: element.scrollLeft, columnScroll: columns, width: latest.current.size.width, height: latest.current.size.height })
    if (target !== null) move({ x: target.scroll, columnId: target.columnId, y: target.columnScroll }, animate)
  }

  // The scroll is saved once the strip rests, by the writer of the group it was scrolled in.
  const pending = useRef<{ write: (change: (strip: Strip) => Strip) => void; scroll: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useStableCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const save = pending.current
    pending.current = null
    save?.write((current) => (Math.abs(current.scroll - save.scroll) < 1e-4 ? current : { ...current, scroll: save.scroll }))
  })
  useEffect(() => flush, [flush])

  // Another group shown, or the area measured for the first time: its own scroll comes back, and its focused pane shows.
  const measured = size.width > 0
  useLayoutEffect(() => {
    flush()
    const element = scroller.current
    if (element === null || !measured) return
    setColumnScroll({})
    gesture.current = null
    element.scrollLeft = strip.scroll * latest.current.size.width
    reveal(false, {})
    // Only a new group or the first measure restores; every other change keeps the scroll as it is.
  }, [stripKey, measured])

  // A pane focused by a click, a key or the sidebar slides into view.
  const known = useRef<{ focused: string; key: string | null } | null>(null)
  const columnCount = layout.columns.length
  useEffect(() => {
    const before = known.current
    known.current = { focused, key: stripKey }
    if (before === null || before.key !== stripKey || !measured) return
    reveal(true, latest.current.columnScroll)
  }, [focused, stripKey, columnCount, measured])

  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const onScroll = () => {
      const { onStrip: write, size: current } = latest.current
      if (write === null || current.width <= 0) return
      pending.current = { write, scroll: element.scrollLeft / current.width }
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, saveDelay)
    }
    // Sideways: taken on the way down, so a terminal or a transcript never scrolls with the jitter of a swipe.
    let position: number | null = null
    let snap: ReturnType<typeof setTimeout> | null = null
    const settle = () => {
      snap = null
      if (gesture.current?.moved !== true) return
      const target = snapTarget(latest.current.layout, element.scrollLeft, latest.current.size.width)
      if (target !== null) move({ x: target }, true)
    }
    const onSideways = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const step = wheelStep(gesture.current, { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, shiftKey: event.shiftKey, time: performance.now() }, latest.current.size.width, (deltaX) => innerScrollsX(target, element, deltaX))
      gesture.current = step.gesture
      if (step.strip === null) return
      event.preventDefault()
      event.stopPropagation()
      // The person's hand wins over any motion under way.
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      position = follow(position, element.scrollLeft, step.strip, Math.max(0, element.scrollWidth - element.clientWidth))
      element.scrollLeft = position
      if (snap !== null) clearTimeout(snap)
      snap = setTimeout(settle, gestureGap + 10)
    }
    const onWheel = (event: WheelEvent) => {
      if (gesture.current?.axis !== 'y') return
      const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-id]') : null
      const paneId = pane?.dataset.paneId
      if (pane === null || paneId === undefined) return
      const column = latest.current.layout.columns.find((candidate) => candidate.panes.some((entry) => entry.id === paneId))
      if (column === undefined || column.height <= latest.current.size.height + 1) return
      if (innerScrolls(event.target as Element, pane, event.deltaY)) return
      const offset = latest.current.columnScroll[column.id] ?? 0
      const next = Math.max(0, Math.min(column.height - latest.current.size.height, offset + event.deltaY))
      if (next === offset) return
      event.preventDefault()
      setColumn(column.id, next)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('wheel', onSideways, { capture: true, passive: false })
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (snap !== null) clearTimeout(snap)
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onSideways, { capture: true })
      element.removeEventListener('wheel', onWheel)
    }
  }, [flush, move])

  // A column scrolled by its offset moves panes without any native scroll; the code layer listens for one.
  useLayoutEffect(() => {
    scroller.current?.dispatchEvent(new Event('scroll'))
  }, [columnScroll])

  const scrolls = layout.overflowX || (layout.columns[0]?.height ?? 0) > size.height + 1
  useEffect(() => onOverflow?.(scrolls), [scrolls, onOverflow])

  return { area, scroller, size, layout, offsetOf, scrollTo: (x) => move({ x }, true) }
}
