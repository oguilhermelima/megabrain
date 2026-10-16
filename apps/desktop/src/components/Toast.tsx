import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePresence } from '@/lib/usePresence'

export interface ToastMessage {
  /** A new id restarts the timer, even for the same text. */
  id: string
  text: string
  /** One way back, such as Undo; running it closes the toast. */
  action?: { label: string; run: () => void }
}

const shownMs = 8000

/**
 * A short note at the bottom of the window after something finished, with at most one action. It
 * leaves on its own after a few seconds, or when closed or acted on; a polite live region reads it.
 */
export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  const { shown, leaving } = usePresence(toast)

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(onClose, shownMs)
    return () => clearTimeout(timer)
  }, [toast, onClose])

  return createPortal(
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
      {shown !== null && (
        <div
          key={shown.id}
          inert={leaving}
          className={`glass pointer-events-auto flex max-w-[min(480px,100%)] items-center gap-3 rounded-full border border-white/[0.1] py-1.5 pr-1.5 pl-4 shadow-2xl transition-[opacity,translate] duration-150 motion-reduce:transition-none ${leaving ? 'translate-y-1 opacity-0' : 'opacity-100'}`}
        >
          <span className="min-w-0 truncate text-[13px] text-ink-100">{shown.text}</span>
          {shown.action !== undefined && (
            <button
              type="button"
              onClick={() => {
                shown.action?.run()
                onClose()
              }}
              className="shrink-0 rounded-full bg-white/[0.1] px-3 py-1 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.16] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
            >
              {shown.action.label}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Dismiss" title="Dismiss" className="grid size-7 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-white/[0.1] hover:text-ink-100">
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
