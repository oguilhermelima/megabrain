import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeTip } from '@/components/tooltip-model'

// WKWebView can leave a native title tooltip stuck on screen, so composer controls use this one.
const delayMs = 400

export interface TooltipAnchor {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: () => void
  'aria-describedby': string | undefined
}

/**
 * A tooltip on document.body for the element `children` renders with the anchor props: shown after a
 * short hover or on keyboard focus, and gone on pointer leave, blur, a press, Escape, a scroll that
 * moves it or the window losing focus.
 */
export function Tooltip({ text, children }: { text: string; children: (anchor: TooltipAnchor) => ReactNode }) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(null)
  }

  useEffect(() => {
    if (anchor === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    // Only a scroll that moves the anchor: a transcript streaming beside it scrolls all the time.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && event.target.contains(anchor)) hide()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', hide)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor])

  useEffect(() => () => clearTimeout(timer.current), [])

  const props: TooltipAnchor = {
    onPointerEnter: (event) => {
      const element = event.currentTarget
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setAnchor(element), delayMs)
    },
    onPointerLeave: hide,
    onFocus: (event) => {
      if (event.currentTarget.matches(':focus-visible')) setAnchor(event.currentTarget)
    },
    onBlur: hide,
    'aria-describedby': anchor === null || text === '' ? undefined : id,
  }
  return (
    <>
      {children(props)}
      {anchor !== null && text !== '' && <TooltipPanel id={id} anchor={anchor} text={text} />}
    </>
  )
}

function TooltipPanel({ id, anchor, text }: { id: string; anchor: HTMLElement; text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    setPosition(placeTip(anchor.getBoundingClientRect(), { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
  }, [anchor, text])
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      style={position === null ? { left: 0, top: 0, visibility: 'hidden' } : position}
      className="pointer-events-none fixed z-[110] w-max max-w-[320px] rounded-lg border border-white/10 bg-ink-900/95 px-3 py-1.5 text-[12px] leading-[1.45] break-words whitespace-pre-line text-ink-200 shadow-lg"
    >
      {text}
    </div>,
    document.body,
  )
}
