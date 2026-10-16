import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { isMac, menuFocusStep, menuSections, shortcutLabel, type MenuGroup } from '@/components/menu-model'
import { placeMenu, type AnchorRect } from '@/advanced/menu-placement'
import { usePresence } from '@/lib/usePresence'

/** One row of a menu as it shows. */
export interface MenuRow {
  label: string
  /** Left out in a menu of plain words. */
  icon?: MenuIcon
  /** Keys as `mod+shift+alt+<key>`; shown right-aligned in the platform's notation (see shortcutLabel). */
  shortcut?: string
  disabled?: boolean
  /** In the danger colour. */
  danger?: boolean
  onSelect: () => void
}

/** A sidebar row menu's item: its group places it (see menu-model.ts); 'danger' items show last, in the danger colour. */
export interface MenuItem {
  label: string
  icon: MenuIcon
  group: MenuGroup
  onSelect: () => void
}

export interface OpenMenu {
  /** The pointer (a rect with no size) or the … button the menu opens from. */
  anchor: AnchorRect
  /** Room between a button and the menu; none at the pointer. */
  gap: number
  /** Rows in sections, with a line between sections. */
  sections: MenuRow[][]
}

/** Where a right click (at the pointer) or a click on a … button (under it) opens a menu. */
function anchorOf(event: ReactMouseEvent<HTMLElement>): Pick<OpenMenu, 'anchor' | 'gap'> {
  if (event.type === 'contextmenu') return { anchor: { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }, gap: 0 }
  const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
  return { anchor: { left, top, right, bottom }, gap: 4 }
}

/** The menu for a right click (at the pointer) or a click on a … button (under it), its items sorted into their groups. */
export function menuFrom(event: ReactMouseEvent<HTMLElement>, items: MenuItem[]): OpenMenu {
  const sections = menuSections(items).map((section) => section.map(({ group, ...row }) => ({ ...row, danger: group === 'danger' })))
  return { ...anchorOf(event), sections }
}

/**
 * A right-click menu's state for rows already in sections: `open` from an onContextMenu handler takes
 * the webview's own menu's place at the pointer, so call it only where the app offers its own actions.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const open = useCallback((event: ReactMouseEvent<HTMLElement>, sections: MenuRow[][]) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ ...anchorOf(event), sections })
  }, [])
  const close = useCallback(() => setMenu(null), [])
  return { menu, open, close }
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
 * A small menu at the pointer or under a button, kept inside the window: arrow keys, Home and End move
 * between the enabled items, Enter picks one, Escape closes and gives focus back to where it was; a
 * click elsewhere, a scroll, Tab or leaving the window closes it. It renders on document.body: the
 * sidebar scrolls and its glass backdrop-filter makes it the containing block for position fixed, so
 * a menu inside it would be clipped at the sidebar's edge.
 */
export function ContextMenu({ menu, onClose }: { menu: OpenMenu | null; onClose: () => void }) {
  const { shown, leaving } = usePresence(menu)
  return shown === null ? null : <MenuCard menu={shown} leaving={leaving} onClose={onClose} />
}

function MenuCard({ menu, leaving, onClose }: { menu: OpenMenu; leaving: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // What had focus when the menu opened: Escape and a picked item hand it back, so an action that
  // writes into the composer finds the caret where it was.
  const before = useRef<Element | null>(null)
  const restore = () => {
    const element = before.current
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (leaving) return
    before.current = document.activeElement
    const outside = (event: Event) => !(event.target instanceof Node) || ref.current?.contains(event.target) !== true
    const onDown = (event: MouseEvent) => {
      if (outside(event)) onClose()
    }
    // Capture: a scroll anywhere, the transcript's included, moves what the menu pointed at.
    const onScroll = (event: Event) => {
      if (outside(event)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        restore()
        onClose()
        return
      }
      if (event.key === 'Tab') {
        onClose()
        return
      }
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const at = buttons.findIndex((button) => button === document.activeElement)
      const next = menuFocusStep(buttons.length, at === -1 ? null : at, event.key)
      if (next === null) return
      event.preventDefault()
      buttons[next]?.focus({ preventScroll: true })
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('wheel', onScroll, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', onScroll, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
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
      onContextMenu={(event) => event.preventDefault()}
      style={position === null ? { left: 0, top: 0, visibility: 'hidden' } : position}
      className="popover fixed z-[100] max-h-[calc(100vh-16px)] min-w-[200px] overflow-y-auto p-1.5 select-none"
    >
      {menu.sections.map((section, index) => (
        <div key={index} role="group" className={index === 0 ? undefined : 'mt-1.5 border-t border-white/[0.08] pt-1.5'}>
          {section.map((row) => (
            <button
              key={row.label}
              type="button"
              role="menuitem"
              disabled={row.disabled === true}
              onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
              onClick={() => {
                restore()
                onClose()
                row.onSelect()
              }}
              className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 ${row.danger === true ? 'text-bad hover:bg-bad/10 focus:bg-bad/10' : 'text-ink-200 hover:bg-white/[0.08] focus:bg-white/[0.08]'}`}
            >
              {row.icon !== undefined && (
                <span className={row.danger === true ? undefined : 'text-ink-400'}>
                  <MenuIconGlyph icon={row.icon} />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.shortcut !== undefined && <span className="ml-4 shrink-0 text-[12px] text-ink-400 tabular-nums">{shortcutLabel(row.shortcut, isMac)}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}
