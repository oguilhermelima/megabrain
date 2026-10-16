import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { promptKey, trapFocus } from '@/chat/composer-look'

/**
 * The app's small dialog: centered on the window over a dimmed backdrop, a title and its content.
 * Enter submits (a focused button takes Enter itself), Esc cancels, Tab stays inside, and focus
 * returns where it was on close. It renders on document.body, so a sidebar or pane that is a
 * containing block for position fixed cannot hold it; the keys are taken in the capture phase so a
 * terminal or editor behind does not get them. The element marked data-autofocus takes focus first.
 */
export function Dialog({ title, busy, onCancel, onSubmit, children }: { title: string; busy: boolean; onCancel: () => void; onSubmit: () => void; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const latest = useRef({ busy, onCancel, onSubmit })
  latest.current = { busy, onCancel, onSubmit }

  useEffect(() => {
    const before = document.activeElement
    card.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = card.current
      if (element === null) return
      const focused = document.activeElement
      const action = promptKey({ key: event.key, onButton: focused instanceof HTMLButtonElement && element.contains(focused) })
      if (action === null) return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'cancel') {
        if (!latest.current.busy) latest.current.onCancel()
      } else if (action === 'confirm') {
        if (!latest.current.busy) latest.current.onSubmit()
      } else {
        const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
        const next = trapFocus(focused instanceof HTMLElement ? controls.indexOf(focused) : -1, controls.length, event.shiftKey)
        if (next !== null) controls[next]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-ink-950/70 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby={titleId} className="glass w-full max-w-md rounded-[28px] border border-white/[0.1] p-6 shadow-2xl">
        <h2 id={titleId} className="text-[17px] font-semibold tracking-[-0.01em] text-ink-100">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
