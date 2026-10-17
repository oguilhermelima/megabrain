import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { api } from '@/api'
import type { AnchorRect } from '@/advanced/menu-placement'
import { arrangeUsage, isEmptyUsageOrder, moveUsage, noUsageOrder, parseUsageOrder, serialiseUsageOrder, toggleUsageHidden, type UsageOrder } from '@/advanced/usage-order'
import { agentUsage, type AgentUsage } from '@/advanced/usage-limits'
import { AgentUsageRow, UsageFooterItem } from '@/advanced/UsageMeters'
import { useSavedSetting } from '@/advanced/useSavedSetting'
import { shimmer, useSettings } from '@/chat/ComposerStatus'
import { Popover } from '@/components/Popover'
import { usePresence } from '@/lib/usePresence'
import { agentLabel } from '@/native-chat/empty-chat'

/** The order and hidden providers the person chose, saved through `settings set usage-order`. */
function useUsageOrder(): { saved: UsageOrder; change: (next: UsageOrder) => void } {
  const { value, change } = useSavedSetting({
    cacheKey: 'megabrain.usage.order',
    seed: () => noUsageOrder,
    parse: parseUsageOrder,
    serialise: serialiseUsageOrder,
    isEmpty: isEmptyUsageOrder,
    read: () => api.usageOrder(),
    write: (json) => api.setUsageOrder(json),
  })
  return { saved: value, change }
}

/**
 * The sidebar's foot: a mark in the agent's colour and a share per provider, from the one settings store,
 * in the order the person chose and without the ones they hid. A click opens a row per provider with a
 * meter per window, the most constraining first, and when each resets; a reading that is old or only
 * the last one known says so. Edit there reorders and hides them. Nothing shows until a provider has one.
 */
export function SidebarUsage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { settings, stale, failed } = useSettings()
  const [open, setOpen] = useState<AnchorRect | null>(null)
  const menu = usePresence(open)
  const close = useRef(() => setOpen(null)).current
  const trigger = useRef<HTMLDivElement>(null)
  // The provider whose item opened the popover, which scrolls to its card.
  const [focused, setFocused] = useState<string | null>(null)
  const { saved, change } = useUsageOrder()
  const usage = settings === null ? [] : agentUsage(settings.limits.readings)
  const { listed, strip } = arrangeUsage(usage, saved)
  const frame = 'shrink-0 border-t border-white/[0.07] px-2 py-2'
  if (settings === null)
    return (
      <div data-sidebar-usage="" aria-busy={!failed} className={`${frame} flex h-12 items-center pl-5 text-[12px] text-ink-500`}>
        {failed ? 'Usage unavailable; retrying' : <span aria-hidden="true" className={`h-2.5 w-24 ${shimmer}`} />}
      </div>
    )
  if (usage.length === 0) return null
  const retrying = stale || failed ? (failed ? 'Last known usage; retrying' : 'Last known usage; refreshing') : null
  return (
    <div data-sidebar-usage="" className={frame}>
      <UsageStrip
        ref={trigger}
        strip={strip}
        open={open === null ? null : focused}
        dimmed={retrying !== null}
        note={retrying}
        onPick={(agent, anchor) => {
          if (open !== null && focused === agent) return setOpen(null)
          setFocused(agent)
          setOpen((current) => current ?? anchor)
        }}
      />
      {menu.shown !== null && (
        <Popover role="dialog" focus="h2" className="max-h-[calc(100vh-16px)] w-[288px] overflow-y-auto p-1" anchor={menu.shown} label="Usage limits" leaving={menu.leaving} onClose={close} trigger={trigger.current}>
          <UsageDetails
            focused={focused}
            usage={usage}
            listed={listed}
            saved={saved}
            onChange={change}
            retrying={retrying}
            onOpenSettings={() => {
              setOpen(null)
              onOpenSettings()
            }}
          />
        </Popover>
      )}
    </div>
  )
}

/** How far a fade runs into the strip at an edge it overflows, in pixels. */
const fade = 16

/**
 * The providers in a row that scrolls sideways when it does not fit: a wheel turn or a trackpad swipe
 * moves it, it rests on an item's edge rather than through one, and a fade marks the side with more.
 * Each item opens the popover on its provider.
 */
function UsageStrip({
  ref,
  strip,
  open,
  dimmed,
  note,
  onPick,
}: {
  ref: RefObject<HTMLDivElement | null>
  strip: AgentUsage[]
  /** The provider whose item opened the popover, or null when it is closed. */
  open: string | null
  dimmed: boolean
  note: string | null
  onPick: (agent: string | null, anchor: AnchorRect) => void
}) {
  const [edges, setEdges] = useState({ start: false, end: false })
  const measure = useCallback(() => {
    const element = ref.current
    if (element === null) return
    const start = element.scrollLeft > 1
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }))
  }, [ref])

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [ref, measure, strip.length])

  // A vertical wheel scrolls the row an item at a time; a sideways swipe scrolls it natively.
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    let owed = 0
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || element.scrollWidth <= element.clientWidth) return
      event.preventDefault()
      owed += event.deltaY
      if (Math.abs(owed) < 24) return
      const items = [...element.querySelectorAll<HTMLElement>('[data-usage-item]')]
      // Item offsets from the first one's, which sits at the row's scroll start.
      const base = items[0]?.offsetLeft ?? 0
      const left = element.scrollLeft
      const ahead = owed > 0
      owed = 0
      const target = (ahead ? items : items.reverse()).find((item) => (ahead ? item.offsetLeft - base > left + 1 : item.offsetLeft - base < left - 1))
      if (target !== undefined) element.scrollTo({ left: target.offsetLeft - base, behavior: 'smooth' })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [ref])

  const anchorOf = () => {
    const rect = (ref.current ?? document.body).getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  }
  const mask = `linear-gradient(to right, ${edges.start ? 'transparent' : '#000'} 0, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges.end ? 'transparent' : '#000'} 100%)`
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={note === null ? 'Usage limits' : `Usage limits. ${note}`}
      onScroll={measure}
      onFocus={(event) => {
        // The popover hands focus back here on Escape; it belongs on the item that opened it.
        if (event.target !== event.currentTarget) return
        event.currentTarget.querySelector<HTMLElement>(`[data-usage-item="${CSS.escape(open ?? '')}"], [data-usage-item]`)?.focus({ preventScroll: true })
      }}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      className={`flex snap-x snap-mandatory items-center gap-1 overflow-x-auto overscroll-x-contain outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${dimmed ? 'opacity-60' : ''}`}
    >
      {strip.length === 0 && (
        <button type="button" data-usage-item="" aria-haspopup="dialog" aria-expanded={open !== null} onMouseDown={keepOpenToggle} onClick={() => onPick(null, anchorOf())} className={itemLook}>
          Usage hidden
        </button>
      )}
      {strip.map((item) => (
        <button
          key={item.agent}
          type="button"
          data-usage-item={item.agent}
          aria-haspopup="dialog"
          aria-expanded={open === item.agent}
          aria-label={`${agentLabel(item.agent)} ${Math.round(item.lead.usedPercent)}% used${item.lead.tone === 'stale' ? ', last known' : ''}`}
          onMouseDown={keepOpenToggle}
          onClick={(event) => {
            event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            onPick(item.agent, anchorOf())
          }}
          className={itemLook}
        >
          <UsageFooterItem usage={item} />
        </button>
      ))}
    </div>
  )
}

const itemLook = 'flex h-8 shrink-0 snap-start items-center gap-1.5 rounded-[10px] px-2 text-[12px] whitespace-nowrap text-ink-300 transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-expanded:bg-row-hover'

/** Lets a second click on an item close the open popover rather than reopen it, and keeps focus where it is. */
const keepOpenToggle = (event: MouseEvent<HTMLButtonElement>) => {
  event.preventDefault()
  event.stopPropagation()
}

const footerAction = 'flex h-7 items-center rounded-[6px] px-2 text-[11.5px] text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:text-ink-100 focus-visible:outline-none'

interface Drag {
  agent: string
  pointer: number
}

function UsageDetails({
  focused,
  usage,
  listed,
  saved,
  onChange,
  retrying,
  onOpenSettings,
}: {
  focused: string | null
  usage: AgentUsage[]
  listed: AgentUsage[]
  saved: UsageOrder
  onChange: (next: UsageOrder) => void
  retrying: string | null
  onOpenSettings: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [announce, setAnnounce] = useState('')
  const list = useRef<HTMLDivElement>(null)
  // The grip a key moved: React moves its card in the DOM, which can drop focus, so it is put back.
  const refocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    const agent = refocus.current
    refocus.current = null
    if (agent === null) return
    const grip = list.current?.querySelector<HTMLElement>(`[data-usage-grip="${CSS.escape(agent)}"]`)
    if (grip !== null && grip !== undefined && document.activeElement !== grip) grip.focus({ preventScroll: true })
  })

  // Opened from a provider's item, the panel scrolls its card into view, below the header.
  useLayoutEffect(() => {
    if (focused === null) return
    const card = list.current?.querySelector<HTMLElement>(`[data-provider-limits="${CSS.escape(focused)}"]`)
    const panel = card?.closest<HTMLElement>('[role="dialog"]')
    if (card === null || card === undefined || panel === null || panel === undefined) return
    const top = card.offsetTop - 36
    if (top < panel.scrollTop || card.offsetTop + card.offsetHeight > panel.scrollTop + panel.clientHeight) panel.scrollTop = Math.max(0, top)
  }, [focused])

  // The providers listed with this one: the shown ones, or the hidden ones after them.
  const group = (agent: string) => listed.filter((item) => saved.hidden.includes(item.agent) === saved.hidden.includes(agent)).map((item) => item.agent)
  const move = (agent: string, index: number) => {
    const next = moveUsage(saved, usage, agent, index)
    if (next.order.join('\n') !== saved.order.join('\n')) onChange(next)
  }

  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>, agent: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const own = group(agent)
    const to = own.indexOf(agent) + (event.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= own.length) return
    refocus.current = agent
    move(agent, to)
    setAnnounce(`${agentLabel(agent)} moved to position ${to + 1} of ${own.length}`)
  }

  // A pointer drag on a grip: the card takes the place among its group whose middles the pointer
  // passed. The window follows the pointer, since moving the card in the DOM drops a capture.
  const onGripDown = (event: PointerEvent<HTMLButtonElement>, agent: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    setDrag({ agent, pointer: event.pointerId })
  }
  const follow = useRef((_event: globalThis.PointerEvent) => {})
  follow.current = (event) => {
    if (drag === null || drag.pointer !== event.pointerId) return
    const own = group(drag.agent)
    const middles = own.flatMap((agent) => {
      if (agent === drag.agent) return []
      const card = list.current?.querySelector<HTMLElement>(`[data-provider-limits="${CSS.escape(agent)}"]`)
      if (card === null || card === undefined) return []
      const rect = card.getBoundingClientRect()
      return [rect.top + rect.height / 2]
    })
    const index = middles.filter((middle) => event.clientY > middle).length
    if (own.indexOf(drag.agent) !== index) move(drag.agent, index)
  }
  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: globalThis.PointerEvent) => follow.current(event)
    const onUp = () => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  return (
    <>
      {/* The heading takes focus on open, which leaves the footer actions unlit until the person moves to them. */}
      <h2 tabIndex={-1} className="flex h-8 items-center px-3 outline-none text-[11px] font-semibold tracking-[0.08em] text-ink-500 uppercase">Usage limits</h2>
      {editing && <p className="px-3 pb-2 text-[11px] leading-4 text-ink-500">Drag a handle, or press Alt+Up or Alt+Down on it, to reorder. The eye shows or hides a provider in the sidebar.</p>}
      <div ref={list} className="flex flex-col gap-0.5">
        {listed.map((item) => (
          <AgentUsageRow
            key={item.agent}
            usage={item}
            focused={item.agent === focused}
            edit={
              editing
                ? {
                    hidden: saved.hidden.includes(item.agent),
                    dragging: drag?.agent === item.agent,
                    onToggle: () => onChange(toggleUsageHidden(saved, item.agent)),
                    grip: {
                      onKeyDown: (event) => onGripKey(event, item.agent),
                      onPointerDown: (event) => onGripDown(event, item.agent),
                    },
                  }
                : null
            }
          />
        ))}
      </div>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {retrying !== null && <p className="px-3 pt-2 text-[11px] text-ink-500">{retrying}</p>}
      <footer className="mt-1 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-1">
        <button type="button" onClick={onOpenSettings} className={footerAction}>
          Usage in Settings
        </button>
        <button
          type="button"
          aria-pressed={editing}
          aria-label={editing ? 'Done reordering usage providers' : 'Reorder and hide usage providers'}
          onClick={() => setEditing((current) => !current)}
          className={`${footerAction} aria-pressed:text-ink-100`}
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </footer>
    </>
  )
}
