import { useEffect, useRef } from 'react'
import { native } from '@/lib/surface'

export interface WindowDropHandlers {
  /** Paths dropped on the window, with where they landed in CSS pixels. */
  onDrop: (paths: string[], x: number, y: number) => void
  /** A drag carrying paths entered or moved over the window (true) or left it, dropped or was cancelled (false). */
  onHover?: (hovering: boolean) => void
}

/**
 * Files and folders dropped on the app window. The native webview takes drops itself and hands
 * over paths, with where they were dropped; a plain browser gives no paths, so nothing fires there.
 */
export function useWindowDrop(handlers: WindowDropHandlers, enabled: boolean) {
  const current = useRef(handlers)
  current.current = handlers
  useEffect(() => {
    if (!native || !enabled) return
    let stopped = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload
          if (payload.type === 'drop') {
            current.current.onHover?.(false)
            current.current.onDrop(payload.paths, payload.position.x / window.devicePixelRatio, payload.position.y / window.devicePixelRatio)
          } else if (payload.type === 'leave') current.current.onHover?.(false)
          else current.current.onHover?.(true)
        })
        .then((stop) => {
          if (stopped) stop()
          else unlisten = stop
        }),
    )
    return () => {
      stopped = true
      unlisten?.()
    }
  }, [enabled])
}

/** Whether a point lies inside an open modal dialog, which owns drops over it. */
export function insideModal(x: number, y: number): boolean {
  return (document.elementFromPoint(x, y)?.closest('[aria-modal="true"]') ?? null) !== null
}
