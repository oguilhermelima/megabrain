import { useState, type PointerEvent } from 'react'
import { clampWidth, readWidth, writeWidth, type WidthLimits } from '@/lib/panel-width'

const browserStorage = () => localStorage

/** A panel width the viewer can drag, remembered under `key`. */
export function usePanelWidth(key: string, limits: WidthLimits) {
  const [width, setWidth] = useState(() => readWidth(browserStorage, key, limits))
  return {
    width,
    /** While dragging: follow the pointer without writing storage. */
    preview: (next: number) => setWidth(clampWidth(next, limits)),
    commit: (next: number) => setWidth(writeWidth(browserStorage, key, next, limits)),
    reset: () => setWidth(writeWidth(browserStorage, key, limits.initial, limits)),
  }
}

/**
 * The drag strip on one edge of a resizable panel. `edge` is the side of the panel it sits on:
 * on the right edge dragging right widens it, on the left edge dragging left does. Double click
 * returns to the initial width. `grip` adds a short pill at mid height that brightens on hover, for a
 * panel whose edge is otherwise hard to find.
 */
export function ResizeHandle({ edge, label, panel, grip = false }: { edge: 'left' | 'right'; label: string; panel: ReturnType<typeof usePanelWidth>; grip?: boolean }) {
  const [dragging, setDragging] = useState(false)
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = panel.width
    const widthAt = (x: number) => startWidth + (edge === 'right' ? x - startX : startX - x)
    setDragging(true)
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'col-resize'
    const onMove = (move: globalThis.PointerEvent) => panel.preview(widthAt(move.clientX))
    const finish = (end: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      setDragging(false)
      panel.commit(widthAt(end.clientX))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      title="Drag to resize · double click to reset"
      onPointerDown={start}
      onDoubleClick={panel.reset}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const step = (event.key === 'ArrowRight') === (edge === 'right') ? 16 : -16
        panel.commit(panel.width + step)
      }}
      className={`group/resize absolute top-0 bottom-0 z-20 w-2 cursor-col-resize select-none focus-visible:outline-none ${edge === 'right' ? '-right-1' : '-left-1'}`}
    >
      <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${dragging ? 'bg-accent/70' : 'bg-transparent group-hover/resize:bg-accent/50 group-focus-visible/resize:bg-accent/70'}`} />
      {grip && (
        <span
          aria-hidden="true"
          className={`absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-100 motion-reduce:transition-none ${dragging ? 'bg-accent' : 'bg-white/[0.14] group-hover/resize:bg-accent/80 group-focus-visible/resize:bg-accent'}`}
        />
      )}
    </div>
  )
}
