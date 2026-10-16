import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { menuFocusStep, menuSections, type MenuGroup } from '@/components/menu-model'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { usePresence } from '@/lib/usePresence'

export interface MenuItem {
  label: string
  icon: MenuIcon
  /** Where it sits in the menu (see menu-model.ts); 'danger' items show last, in the danger colour. */
  group: MenuGroup
  onSelect: () => void
}

export interface OpenMenu {
  /** The pointer (a rect with no size) or the … button the menu opens from. */
  anchor: AnchorRect
  /** Room between a button and the menu; none at the pointer. */
  gap: number
  items: MenuItem[]
}

/** The menu for a right click (at the pointer) or a click on a … button (under it). */
export function menuFrom(event: ReactMouseEvent<HTMLElement>, items: MenuItem[]): OpenMenu {
  if (event.type === 'contextmenu') return { anchor: { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }, gap: 0, items }
  const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
  return { anchor: { left, top, right, bottom }, gap: 4, items }
}

/** The keys that open a focused element's context menu: the menu key, or Shift+F10. */
export const isMenuKey = (event: ReactKeyboardEvent) => event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')

/**
 * Opens the context menu of the focused element from the keyboard: a right click at its middle, so
 * every onContextMenu handler serves both. Use as an onKeyDown on a list of rows.
 */
export function openMenuFromKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
  if (!isMenuKey(event) || !(event.target instanceof HTMLElement)) return
  event.preventDefault()
  const rect = event.target.getBoundingClientRect()
  event.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + Math.min(rect.width / 2, 24), clientY: rect.top + rect.height / 2 }))
}

/**
 * A small menu at the pointer or under a button: arrow keys, Home and End move between items, a click
 * elsewhere or Escape closes it. It renders on document.body: the sidebar scrolls and its glass
 * backdrop-filter makes it the containing block for position fixed, so a menu inside it would be
 * clipped at the sidebar's edge.
 */
export function ContextMenu({ menu, onClose }: { menu: OpenMenu | null; onClose: () => void }) {
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
      if (event.key === 'Escape') {
        onClose()
        return
      }
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const at = buttons.findIndex((button) => button === document.activeElement)
      const next = menuFocusStep(buttons.length, at === -1 ? null : at, event.key)
      if (next === null) return
      event.preventDefault()
      buttons[next]?.focus()
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
      {menuSections(menu.items).map((section, index) => (
        <div key={section[0]?.group} role="group" className={index === 0 ? undefined : 'mt-1.5 border-t border-white/[0.08] pt-1.5'}>
          {section.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                onClose()
                item.onSelect()
              }}
              className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] focus-visible:outline-none ${item.group === 'danger' ? 'text-bad hover:bg-bad/10 focus-visible:bg-bad/10' : 'text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08]'}`}
            >
              <span className={item.group === 'danger' ? undefined : 'text-ink-400'}>
                <MenuIconGlyph icon={item.icon} />
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}
