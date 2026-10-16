import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { usePresence } from '@/lib/usePresence'

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
export function RowMenu({ menu, onClose }: { menu: OpenMenu | null; onClose: () => void }) {
  const { shown, leaving } = usePresence(menu)
  return shown === null ? null : <MenuCard menu={shown} leaving={leaving} onClose={onClose} />
}

function MenuCard({ menu, leaving, onClose }: { menu: OpenMenu; leaving: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (leaving) return
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
  }, [onClose, leaving])
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
      data-leaving={leaving || undefined}
      inert={leaving}
      style={position === null ? { left: 0, top: 0, visibility: 'hidden' } : position}
      className="popover fixed z-[100] max-h-[calc(100vh-16px)] min-w-[200px] overflow-y-auto p-1.5"
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
