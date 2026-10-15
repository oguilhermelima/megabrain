import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { Button, ErrorNote, Spinner } from '@/components/ui'

export interface MenuItem {
  label: string
  danger?: boolean
  onSelect: () => void
}

export interface OpenMenu {
  /** The pointer (a rect with no size) or the … button the menu opens from. */
  anchor: AnchorRect
  /** Room between a button and the menu; none at the pointer. */
  gap: number
  items: MenuItem[]
}

/**
 * A small menu at the pointer or under a button, closed by a click elsewhere or Escape. It renders
 * on document.body: the sidebar scrolls and its glass backdrop-filter makes it the containing block
 * for position fixed, so a menu inside it would be clipped at the sidebar's edge.
 */
export function RowMenu({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    ref.current?.querySelector('button')?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // Measured before paint, then flipped left or up when it would leave the window.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    setPosition(placeMenu(menu.anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }, menu.gap))
  }, [menu])
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={position === null ? { left: 0, top: 0, visibility: 'hidden' } : position}
      className="glass fixed z-[100] max-h-[calc(100vh-16px)] min-w-[200px] overflow-y-auto rounded-[16px] border border-white/[0.1] p-1.5 shadow-2xl"
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
          className={`block w-full rounded-[10px] px-3 py-1.5 text-left text-[13px] focus-visible:outline-none ${item.danger === true ? 'text-bad hover:bg-bad/10 focus-visible:bg-bad/10' : 'text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08]'}`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

export interface PendingConfirm {
  title: string
  body: string
  action: string
  run: () => Promise<void>
}

/** Asks before a removal and shows megabrain's own error text when it refuses. */
export function ConfirmDialog({ confirm, onClose, onDone }: { confirm: PendingConfirm; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  const run = () => {
    setRunning(true)
    setError(null)
    confirm.run().then(
      () => {
        setRunning(false)
        onDone()
      },
      (caught: unknown) => {
        setRunning(false)
        setError(caught)
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 px-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-label={confirm.title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose()
      }}
    >
      <div className="glass w-full max-w-md rounded-[28px] border border-white/[0.1] p-6 shadow-2xl">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink-100">{confirm.title}</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-300">{confirm.body}</p>
        {error !== null && (
          <div className="mt-4">
            <ErrorNote error={error} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="danger" onClick={run} disabled={running}>
            {running ? <Spinner /> : confirm.action}
          </Button>
        </div>
      </div>
    </div>
  )
}
