import { useEffect, useRef, useState, type ReactNode } from 'react'

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Content that folds open and shut: its height and opacity ease over 180 ms (a grid row going
 * between 0fr and 1fr, so nothing jumps when it ends). Closed content leaves the DOM once folded,
 * so a long collapsed list costs nothing; with reduced motion it opens and closes at once.
 */
export function Collapse({ open, className = '', children }: { open: boolean; className?: string; children: ReactNode }) {
  // mounted: the content is in the DOM; expanded: it is at full height.
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  // Clipped only while it moves, so drop lines and focus rings at the edges show once it settles.
  const [moving, setMoving] = useState(false)
  const frame = useRef<number | null>(null)
  const shown = useRef(open)

  useEffect(() => {
    // The first render already shows the right state; only a change moves.
    if (shown.current === open) return
    shown.current = open
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    const instant = reducedMotion()
    setMoving(!instant)
    if (open) {
      setMounted(true)
      // One frame folded first, so the open eases from nothing.
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => setExpanded(true))
      })
    } else {
      setExpanded(false)
      if (instant) setMounted(false)
    }
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [open])

  if (!mounted) return null
  return (
    <div
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return
        setMoving(false)
        if (!open) setMounted(false)
      }}
      style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      // One column as wide as the container: an auto track would grow to the content's unwrapped width
      // once overflow-hidden lifts, pushing every row's trailing badge and time past the sidebar's edge.
      className="grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-[180ms] ease-out motion-reduce:transition-none"
    >
      <div className={`min-h-0 min-w-0 ${moving || !expanded ? 'overflow-hidden' : ''} ${className}`}>{children}</div>
    </div>
  )
}
