import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { pressedOutside } from '@/components/popover-model'

/**
 * A panel on document.body hung from `anchor` and flipped inside the window. A press outside it and
 * its trigger, Escape or the window losing focus closes it; Escape hands focus back to the trigger.
 * It is inert while `leaving`.
 */
export function Popover({
  anchor,
  label,
  role,
  leaving,
  onClose,
  trigger,
  focus,
  closeWhenMoved = false,
  gap = 6,
  maxHeight,
  className,
  children,
}: {
  anchor: AnchorRect
  label: string
  role: 'menu' | 'dialog'
  leaving: boolean
  onClose: () => void
  /** The button that opened it: pressing it again is its own toggle, not a press outside. */
  trigger: HTMLElement | null
  /** The first element matching this selector takes focus on open. */
  focus: string
  /** Closes when the page scrolls or the window resizes, which moves the trigger it hangs from. */
  closeWhenMoved?: boolean
  /** Space between the trigger and the panel, in pixels. */
  gap?: number
  /** The tallest the panel grows, in pixels, past which it scrolls; the className caps it otherwise. */
  maxHeight?: number
  /** Size, padding and overflow of the panel. */
  className: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (leaving) return
    const outside = (event: Event) => pressedOutside(event.target instanceof Node ? event.target : null, ref.current, trigger)
    const onDown = (event: MouseEvent) => {
      if (outside(event)) onClose()
    }
    const onScroll = (event: Event) => {
      if (outside(event)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      trigger?.focus({ preventScroll: true })
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    if (closeWhenMoved) {
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onClose)
    }
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, leaving, trigger, focus, closeWhenMoved])

  // Measured before paint and again when the content changes size, then flipped when it would leave the window.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    // The layout size, not getBoundingClientRect: the pop-in animation scales the panel while it is measured.
    const place = () => setPosition(placeMenu(anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, gap))
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    return () => observer.disconnect()
  }, [anchor, gap])

  // Focus moves in once the panel is placed: it is hidden until then, and a hidden element takes no focus.
  const placed = position !== null
  useEffect(() => {
    if (placed && !leaving) ref.current?.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true })
  }, [placed, leaving, focus])

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      data-leaving={leaving || undefined}
      inert={leaving}
      style={{ ...(position === null ? { left: 0, top: 0, visibility: 'hidden' } : position), maxHeight }}
      className={`popover fixed z-[100] ${className}`}
    >
      {children}
    </div>,
    document.body,
  )
}
