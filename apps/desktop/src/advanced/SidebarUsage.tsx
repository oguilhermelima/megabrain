import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { api } from '@/api'
import type { AnchorRect } from '@/advanced/menu-placement'
import { arrangeUsage, isEmptyUsageOrder, moveUsage, noUsageOrder, parseUsageOrder, serialiseUsageOrder, toggleUsageHidden, usageChip, type UsageOrder } from '@/advanced/usage-order'
import { useSavedSetting } from '@/advanced/useSavedSetting'
import { providerUsage, resetDistance, type AgentLimit, type ProviderUsage } from '@/chat/composer-status'
import { Ring, shimmer, toneBar, toneText, useSettings } from '@/chat/ComposerStatus'
import { AgentIcon } from '@/components/agent-icons'
import { Popover } from '@/components/Popover'
import { usePresence } from '@/lib/usePresence'
import { agentLabel } from '@/native-chat/empty-chat'

const windowNames: Record<string, string> = { '5h': '5-hour', weekly: 'Weekly' }
const windowName = (window: string) => windowNames[window] ?? window

const resetClock = (at: Date) => at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** A limit as a ring and its share, coloured by tone: the compact readout the sidebar's foot shows. */
function RingShare({ limit }: { limit: AgentLimit }) {
  return (
    <>
      <Ring fraction={limit.usedPercent / 100} tone={limit.tone} />
      <span className={`tabular-nums ${limit.tone === 'normal' ? 'text-ink-300' : toneText[limit.tone]}`}>{`${Math.round(limit.usedPercent)}%`}</span>
    </>
  )
}

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
 * The sidebar's foot: a mark, ring and share per provider with a reading, from the one settings store,
 * in the order the person chose and without the ones they hid. A click opens a card per provider with
 * every window's bar and share, when each resets and how old the reading is; Edit there reorders and
 * hides them. Nothing shows until a provider has one.
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
  const usage = settings === null ? [] : providerUsage(settings.limits.readings)
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
        <Popover role="dialog" focus="button" className="max-h-[calc(100vh-16px)] w-[288px] overflow-y-auto p-1" anchor={menu.shown} label="Usage limits" leaving={menu.leaving} onClose={close} trigger={trigger.current}>
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
  strip: ProviderUsage[]
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
          aria-label={`${agentLabel(item.agent)} ${Math.round(item.highest.usedPercent)}% used`}
          onMouseDown={keepOpenToggle}
          onClick={(event) => {
            event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            onPick(item.agent, anchorOf())
          }}
          className={itemLook}
        >
          <AgentIcon agent={item.agent} size={13} className="text-ink-400" />
          <RingShare limit={item.highest} />
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
  usage: ProviderUsage[]
  listed: ProviderUsage[]
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
      <header className="flex h-8 items-center gap-2 pr-1 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.08em] text-ink-500 uppercase">Usage limits</h2>
        <button
          type="button"
          aria-pressed={editing}
          aria-label={editing ? 'Done reordering usage providers' : 'Reorder and hide usage providers'}
          onClick={() => setEditing((current) => !current)}
          className="flex h-6 items-center rounded-[6px] px-2 text-[11.5px] text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:text-ink-100 focus-visible:outline-none aria-pressed:bg-white/[0.08] aria-pressed:text-ink-100"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </header>
      {editing && <p className="px-3 pb-2 text-[11px] leading-4 text-ink-500">Drag a handle, or press Alt+Up or Alt+Down on it, to reorder. The eye shows or hides a provider in the sidebar.</p>}
      <div ref={list} className="flex flex-col gap-1">
        {listed.map((item) => (
          <ProviderCard
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
      {retrying !== null && <p className="px-3 pt-2 text-[11.5px] text-ink-500">{retrying}</p>}
      <div className="mt-1 border-t border-white/[0.06] pt-1">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-8 w-full items-center rounded-[8px] px-3 text-left text-[12.5px] text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:outline-none"
        >
          Usage in Settings
        </button>
      </div>
    </>
  )
}

/** When each window resets, in one quiet line: "Resets 5-hour in 2h 10m · weekly in 5d 9h"; the exact times are read out. */
function ResetLine({ limits }: { limits: AgentLimit[] }) {
  const known = limits.flatMap((limit) => (limit.resetsAt === null ? [] : [{ window: limit.window, at: limit.resetsAt }]))
  if (known.length === 0) return <p className="truncate pt-1 text-[11px] text-ink-500">Reset time unknown</p>
  return (
    <p className="truncate pt-1 text-[11px] text-ink-500" aria-label={`Resets: ${known.map((reset) => `${windowName(reset.window)} ${resetClock(reset.at)}`).join(', ')}`}>
      {`Resets ${known.map((reset) => `${windowName(reset.window).toLowerCase()} ${resetDistance(reset.at)}`).join(' · ')}`}
    </p>
  )
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
      {[4.5, 8, 11.5].flatMap((y) => [6, 10].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.1" />))}
    </svg>
  )
}

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4ZM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3" />
      {hidden && <path d="M3 13 13 3" />}
    </svg>
  )
}

interface CardEdit {
  hidden: boolean
  dragging: boolean
  onToggle: () => void
  grip: {
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  }
}

const smallButton = 'flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-500 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:text-ink-100 focus-visible:outline-none'

/** One provider: its mark, name and a chip for how old the reading is, then a line per window; editing, a grip to move it and an eye to hide it. */
function ProviderCard({ usage, focused, edit }: { usage: ProviderUsage; focused: boolean; edit: CardEdit | null }) {
  const chip = usageChip(usage)
  const name = agentLabel(usage.agent)
  const hidden = edit?.hidden === true
  return (
    <section
      data-provider-limits={usage.agent}
      data-hidden={hidden || undefined}
      className={`rounded-[8px] px-3 py-2 transition-[background-color,opacity] motion-reduce:transition-none ${edit?.dragging === true ? 'bg-white/[0.08]' : focused ? 'bg-white/[0.06]' : 'bg-white/[0.03]'} ${hidden ? 'opacity-50' : ''}`}
    >
      <div className="flex h-6 items-center gap-2">
        {edit !== null && (
          <button type="button" data-usage-grip={usage.agent} aria-label={`Move ${name}`} aria-roledescription="drag handle" {...edit.grip} className={`${smallButton} -ml-2 cursor-grab touch-none active:cursor-grabbing`}>
            <GripIcon />
          </button>
        )}
        <AgentIcon agent={usage.agent} size={14} className="text-ink-300" />
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-100">{name}</h3>
        {edit !== null && (
          <button type="button" aria-pressed={!hidden} aria-label={`Show ${name} in the sidebar`} onClick={edit.onToggle} className={`${smallButton} -mr-2`}>
            <EyeIcon hidden={hidden} />
          </button>
        )}
        {edit === null && chip !== null && <span className={`flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] ${chip.stale ? 'bg-warn/10 text-warn' : 'bg-white/[0.05] text-ink-500'}`}>{chip.text}</span>}
      </div>
      <ul className="pt-1">
        {usage.limits.map((limit) => (
          <li key={limit.window} className="grid h-6 grid-cols-[64px_minmax(0,1fr)_36px] items-center gap-2" aria-label={`${windowName(limit.window)}: ${Math.round(limit.usedPercent)}% used`}>
            <span aria-hidden="true" className="truncate text-[12px] text-ink-300">
              {windowName(limit.window)}
            </span>
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-white/[0.1]">
              <span className={`block h-full rounded-full ${toneBar[limit.tone]}`} style={{ width: `${Math.max(3, Math.round(limit.usedPercent))}%` }} />
            </span>
            <span aria-hidden="true" className={`text-right text-[12px] font-semibold tabular-nums ${limit.tone === 'normal' ? 'text-ink-100' : toneText[limit.tone]}`}>{`${Math.round(limit.usedPercent)}%`}</span>
          </li>
        ))}
      </ul>
      <ResetLine limits={usage.limits} />
    </section>
  )
}
