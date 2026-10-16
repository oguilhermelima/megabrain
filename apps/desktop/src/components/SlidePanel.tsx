import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { tokenMs } from '@/lib/motion'
import { startPanelMotion } from '@/lib/panel-motion'
import { usePresence } from '@/lib/usePresence'

/**
 * A side panel that slides open and shut. Only its outer box changes width, so the main area beside
 * it follows; the panel inside keeps its full width and is uncovered, so nothing in it reflows, and
 * terminals refit once when it stops (lib/panel-motion). It does not slide when it first renders
 * unless `appear` says so. Shut, its content is unmounted, or kept hidden with `keepMounted`; a
 * `children` function is told whether the panel is on screen, which it still is while it slides shut.
 */
export function SlidePanel({
  open,
  side,
  width,
  maxWidth,
  keepMounted = false,
  appear = false,
  className,
  handle,
  children,
}: {
  open: boolean
  /** The window edge it sits against. */
  side: 'left' | 'right'
  width: number
  maxWidth?: string
  keepMounted?: boolean
  appear?: boolean
  className: string
  /** The resize handle, on the edge toward the main area, never clipped. */
  handle: ReactNode
  children: ReactNode | ((present: boolean) => ReactNode)
}) {
  const { leaving } = usePresence(open || null, '--motion-panel')
  const present = open || leaving
  const [slid, setSlid] = useState(appear && open)
  const last = useRef(appear ? false : open)
  useLayoutEffect(() => {
    if (last.current === open) return
    last.current = open
    setSlid(true)
    const end = startPanelMotion()
    const timer = setTimeout(end, tokenMs('--motion-panel'))
    return () => {
      clearTimeout(timer)
      end()
    }
  }, [open])

  const size: CSSProperties = { width, maxWidth }
  return (
    <div style={size} className={`relative shrink-0 ${present ? '' : 'hidden'} ${leaving ? 'slide-out' : slid ? 'slide-in' : ''}`}>
      <div className={`absolute inset-0 flex overflow-hidden ${side === 'right' ? 'justify-end' : ''}`}>
        <aside style={size} className={`relative flex h-full shrink-0 flex-col ${className}`}>
          {(present || keepMounted) && (typeof children === 'function' ? children(present) : children)}
        </aside>
      </div>
      {present && handle}
    </div>
  )
}
