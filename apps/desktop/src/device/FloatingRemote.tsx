import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { clampRemote, dragRemote, readRemote, writeRemote, type RemotePlace, type RemoteState } from '@/device/remote-model'
import { tapSlop } from '@/device/screen-model'

const browserStorage = () => localStorage

/** The client size of an element and of the view it floats in, as either resizes. */
function useSizes() {
  const ref = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState({ own: { width: 0, height: 0 }, view: { width: 0, height: 0 } })
  useLayoutEffect(() => {
    const element = ref.current
    const view = element?.parentElement
    if (element === null || view === null || view === undefined) return
    const measure = () => setSizes({ own: { width: element.offsetWidth, height: element.offsetHeight }, view: { width: view.clientWidth, height: view.clientHeight } })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(view)
    return () => observer.disconnect()
  }, [])
  return [ref, sizes] as const
}

/**
 * The Apple TV remote over the screen rather than under it, so the screen keeps the height: dragged
 * by its grip (or, folded, by its handle) anywhere inside the view and clear of the zoom bar, and
 * folded to a round handle that a click opens again. Place and fold are remembered per viewer
 * (remote-model). The screen's own keys keep driving the remote while it is folded.
 */
export function FloatingRemote({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RemoteState>(() => readRemote(browserStorage))
  const [ref, sizes] = useSizes()
  const drag = useRef<{ x: number; y: number; from: RemotePlace; id: number; moved: boolean } | null>(null)
  // The click that ends a drag of the folded handle must not open it.
  const dragged = useRef(false)
  const place = clampRemote(state, sizes.own, sizes.view)
  const save = (next: RemoteState) => setState(writeRemote(browserStorage, next))

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragged.current = false
    drag.current = { x: event.clientX, y: event.clientY, from: place, id: event.pointerId, moved: false }
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current
    if (start === null || start.id !== event.pointerId) return
    const delta = { x: event.clientX - start.x, y: event.clientY - start.y }
    if (!start.moved && Math.hypot(delta.x, delta.y) < tapSlop) return
    start.moved = true
    setState((current) => ({ ...current, ...clampRemote(dragRemote(start.from, delta), sizes.own, sizes.view) }))
  }
  // A drag remembers where it ended.
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current
    drag.current = null
    if (start === null || start.id !== event.pointerId) return
    dragged.current = start.moved
    if (start.moved) save({ ...state, ...place })
  }
  const unfold = () => {
    if (dragged.current) dragged.current = false
    else save({ ...state, ...place, collapsed: false })
  }
  const dragging = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: () => (drag.current = null) }

  return (
    <div ref={ref} style={{ right: place.right, bottom: place.bottom }} className="absolute z-20">
      {state.collapsed ? (
        <button
          type="button"
          aria-label="Show remote"
          title="Show remote (drag to move)"
          {...dragging}
          onClick={unfold}
          className="grid size-9 cursor-grab touch-none place-items-center rounded-full border border-white/[0.14] bg-ink-900/90 text-ink-300 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.8)] backdrop-blur transition-colors duration-100 select-none hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:cursor-grabbing motion-reduce:transition-none"
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <rect x="5" y="2" width="6" height="12" rx="3" />
            <circle cx="8" cy="5.5" r="1" />
          </svg>
        </button>
      ) : (
        <div className="flex flex-col rounded-2xl border border-white/[0.1] bg-ink-900/90 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.85)] backdrop-blur">
          <div className="flex items-center">
            <div {...dragging} aria-hidden="true" title="Drag to move" className="flex h-5 flex-1 cursor-grab touch-none items-center justify-center select-none active:cursor-grabbing">
              <span className="h-1 w-8 rounded-full bg-white/[0.16]" />
            </div>
            <button type="button" aria-label="Fold remote" title="Fold remote" onClick={() => save({ ...state, ...place, collapsed: true })} className="mr-1 grid size-5 place-items-center rounded-full text-ink-400 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none">
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M4 8h8" />
              </svg>
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  )
}
