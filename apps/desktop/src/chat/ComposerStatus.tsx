import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Settings } from '@/api/schema'
import type { AnchorRect } from '@/advanced/menu-placement'
import { Popover } from '@/components/Popover'
import { usePresence } from '@/lib/usePresence'
import {
  agentLimits,
  agentModels,
  contextMeter,
  contextWindow,
  displayName,
  effortLevels,
  effortName,
  findModel,
  limitWindows,
  formatTokens,
  highestLimit,
  limitsLayout,
  menuGroups,
  modelHint,
  modelWindows,
  pickerLabel,
  switchNeedsConfirm,
  switchTarget,
  type AgentLimit,
  type ContextMeter,
  type LimitTone,
} from '@/chat/composer-status'
import { ringOffset } from '@/chat/composer-look'
import { AgentIcon } from '@/components/agent-icons'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { appSettings } from '@/lib/app-settings'
import { isStale } from '@/lib/shared-read'

const toneText: Record<LimitTone, string> = { normal: 'text-ink-400', amber: 'text-warn', red: 'text-bad' }
const toneBar: Record<LimitTone, string> = { normal: 'bg-ok', amber: 'bg-warn', red: 'bg-bad' }

/** The settings, whether they are older than a fresh read would be, and whether the last read failed. */
function useSettings(): { settings: Settings | null; stale: boolean; failed: boolean } {
  const store = appSettings()
  const subscribe = useCallback(
    (notify: () => void) => {
      const stopRead = store.subscribe(notify)
      const stopChange = store.onChange(notify)
      return () => {
        stopRead()
        stopChange()
      }
    },
    [store],
  )
  const settings = useSyncExternalStore(subscribe, store.get)
  const failed = useSyncExternalStore(subscribe, store.failed)
  return { settings, stale: isStale(store.readAt(), Date.now()), failed }
}

type Models = Settings['models']

/** The composer's menus: a click elsewhere, Escape or blur closes them. */
const menuLook = { role: 'menu', focus: '[aria-checked="true"], button', className: 'max-h-[calc(100vh-16px)] min-w-[240px] overflow-y-auto p-2' } as const

export interface ModelPick {
  /** The id to run, Claude's with [1m] for the 1M window. */
  model: string
  window: number | null
  effort: string | undefined
  /** How people say the model, from the registry when it names it. */
  name: string
}

type MenuPick = Omit<ModelPick, 'name'>

const heading = 'px-2 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-500 uppercase'

/** Two or more choices side by side in equal widths, the chosen one raised. */
function Segmented<T extends string | number>({ label, options, value, onPick }: { label: string; options: { value: T; label: string }[]; value: T | undefined; onPick: (value: T) => void }) {
  return (
    <div className="px-1 pt-2 pb-1">
      <p className={heading}>{label}</p>
      <div role="radiogroup" aria-label={label} className="grid gap-0.5 rounded-[11px] bg-white/[0.06] p-[3px]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onPick(option.value)}
            className={`h-7 min-w-0 truncate rounded-[8px] px-1.5 text-center text-[12.5px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 motion-reduce:transition-none ${option.value === value ? 'bg-white/[0.15] font-medium text-ink-100 shadow-[0_1px_3px_rgba(0,0,0,0.35)]' : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-200'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ModelRow({ item, checked, onPick }: { item: Models[number]; checked: boolean; onPick: () => void }) {
  const name = displayName(item.model, [item])
  const hint = modelHint(item.model)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={item.model}
      onClick={onPick}
      // One height with or without a hint, so the list stays even.
      className={`flex h-11 w-full items-center gap-3 rounded-[10px] px-2.5 text-left transition-colors duration-100 focus-visible:outline-none motion-reduce:transition-none ${checked ? 'bg-accent/[0.12] hover:bg-accent/[0.16] focus-visible:bg-accent/[0.18]' : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.08]'}`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13.5px] leading-5 ${checked ? 'font-medium text-ink-100' : 'text-ink-200'}`}>{name}</span>
        {hint !== null && <span className={`block truncate text-[11.5px] leading-4 ${checked ? 'text-accent/80' : 'text-ink-500'}`}>{hint}</span>}
      </span>
      {checked && (
        <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      )}
    </button>
  )
}

/**
 * The agent's current models with a hint each, the model in use when it is an older one, the other
 * older ones folded away and closed on every open, then the window and the effort of the model in
 * use as segmented controls. A pick switches at once, except that a chat
 * already holding context asks first: the switch drops the prompt cache.
 */
function ModelMenu({
  anchor,
  agent,
  models,
  current,
  window: currentWindow,
  effort,
  native,
  contextTokens,
  onPick,
  onAsk,
  leaving,
  onClose,
  trigger,
}: {
  anchor: AnchorRect
  agent: string | null
  models: Models
  current: string | null
  window: number | null
  effort: string | undefined
  /** True for a native chat, which sets effort itself; a session takes it by command when its agent has one. */
  native: boolean
  contextTokens: number | null | undefined
  onPick: (pick: MenuPick) => void
  /** A switch that needs a yes first: the picker closes and the app's confirm dialog asks. */
  onAsk: (confirm: PendingConfirm) => void
  leaving: boolean
  onClose: () => void
  trigger: HTMLElement | null
}) {
  const groups = menuGroups(models, current)
  const entry = findModel(models, current)
  const [showOlder, setShowOlder] = useState(false)
  const windows = current === null || current === '' ? [] : modelWindows(entry, agent)
  const levels = effortLevels(entry, agent, native)

  const choose = (pick: MenuPick) => {
    if (!switchNeedsConfirm(current, pick.model, contextTokens)) {
      onPick(pick)
      return
    }
    onAsk({
      title: `Switch to ${pickerLabel(displayName(pick.model, models), windows.length > 1 || pick.window !== currentWindow ? pick.window : null, pick.effort)}?`,
      body: `Switching model drops the prompt cache, so the next message reprocesses the whole context${typeof contextTokens === 'number' ? ` (about ${formatTokens(contextTokens)} tokens)` : ''}.`,
      action: 'Switch',
      tone: 'primary',
      run: async () => onPick(pick),
    })
  }
  const pickModel = (item: Models[number]) => {
    const target = switchTarget(item.model, modelWindows(item, agent), currentWindow)
    // Effort carries over to a model that has the same level.
    choose({ ...target, effort: effort !== undefined && item.reasoning.levels.includes(effort) ? effort : undefined })
  }
  const row = (item: Models[number]) => <ModelRow key={item.model} item={item} checked={item === entry} onPick={() => pickModel(item)} />

  return (
    <Popover {...menuLook} anchor={anchor} label="Model" leaving={leaving} onClose={onClose} trigger={trigger}>
      <div className="w-[304px] max-w-[calc(100vw-32px)]">
        <>
          <p className={`${heading} pt-1`}>Model</p>
          {groups.current.map(row)}
          {groups.selected !== null && row(groups.selected)}
          {groups.older.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={showOlder}
                onClick={() => setShowOlder((open) => !open)}
                className="mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-[10px] px-2.5 text-left text-[12px] text-ink-500 transition-colors duration-100 hover:bg-white/[0.04] hover:text-ink-300 focus-visible:bg-white/[0.06] focus-visible:text-ink-300 focus-visible:outline-none motion-reduce:transition-none"
              >
                <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${showOlder ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 4 4 4-4 4" />
                </svg>
                {`Older models (${groups.older.length})`}
              </button>
              {showOlder && groups.older.map(row)}
            </>
          )}
          {(windows.length > 1 || levels.length > 0) && current !== null && <div className="mx-1 my-2 h-px bg-white/[0.07]" />}
          {windows.length > 1 && current !== null && (
            <Segmented
              label="Context window"
              options={windows.map((tokens) => ({ value: tokens, label: formatTokens(tokens) }))}
              value={currentWindow ?? undefined}
              onPick={(tokens) => {
                if (tokens !== currentWindow) choose({ ...switchTarget(current, windows, tokens), effort })
              }}
            />
          )}
          {levels.length > 0 && current !== null && (
            <Segmented
              label="Effort"
              options={levels.map((level) => ({ value: level, label: effortName(level) }))}
              value={effort}
              onPick={(level) => {
                if (level !== effort) onPick({ model: current, window: currentWindow, effort: level })
              }}
            />
          )}
        </>
      </div>
    </Popover>
  )
}

/** A bar with rounded ends, filled to a share and coloured by tone; `small` is the compact line's. */
function Meter({ fraction, tone, small = false }: { fraction: number; tone: LimitTone; small?: boolean }) {
  return (
    <span className={`shrink-0 overflow-hidden rounded-full bg-white/[0.12] ${small ? 'h-1 w-6' : 'h-1.5 w-16'}`}>
      <span className={`block h-full rounded-full ${toneBar[tone]}`} style={{ width: `${Math.max(3, Math.round(fraction * 100))}%` }} />
    </span>
  )
}

const windowNames: Record<string, string> = { '5h': '5-hour', weekly: 'Weekly' }
const shortWindowNames: Record<string, string> = { '5h': '5h', weekly: 'Wk' }

/** The limit in words, with the exact reset time, for a tooltip. */
function limitTitle(agent: string, limit: AgentLimit): string {
  const when = limit.resetsAt === null ? 'reset time unknown' : `resets ${limit.resetsAt.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
  return `${agent} ${windowNames[limit.window] ?? limit.window} limit: ${Math.round(limit.usedPercent)}% used, ${when}`
}

function LimitMeter({ agent, limit }: { agent: string; limit: AgentLimit }) {
  const percent = Math.round(limit.usedPercent)
  return (
    <span className="flex h-6 min-w-0 items-center gap-2" title={limitTitle(agent, limit)}>
      <span className="shrink-0 font-medium text-ink-200">{windowNames[limit.window] ?? limit.window}</span>
      <Meter fraction={limit.usedPercent / 100} tone={limit.tone} />
      <span className={`shrink-0 font-semibold tabular-nums ${limit.tone === 'normal' ? 'text-ink-100' : toneText[limit.tone]}`}>{`${percent}%`}</span>
      {limit.resets !== null && <span className="min-w-0 truncate text-ink-400">{limit.resets}</span>}
    </span>
  )
}

/** One window on the compact line: its short name, a tiny bar and the share; the reset is in the tooltip. */
function CompactLimit({ agent, limit }: { agent: string; limit: AgentLimit }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={limitTitle(agent, limit)}>
      <span className="shrink-0 text-ink-400">{shortWindowNames[limit.window] ?? limit.window}</span>
      <Meter fraction={limit.usedPercent / 100} tone={limit.tone} small />
      <span className={`shrink-0 tabular-nums ${limit.tone === 'normal' ? 'text-ink-300' : toneText[limit.tone]}`}>{`${Math.round(limit.usedPercent)}%`}</span>
    </span>
  )
}

const ringRadius = 6
const ringCircumference = 2 * Math.PI * ringRadius

/** A ring filled to a share: an arc on a faint track from twelve o'clock, still, coloured by tone. */
function Ring({ fraction, tone }: { fraction: number; tone: LimitTone }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-4 shrink-0 ${toneText[tone]}`} aria-hidden="true">
      <circle cx="8" cy="8" r={ringRadius} fill="none" strokeWidth="2.25" className="stroke-white/[0.13]" />
      <circle
        cx="8"
        cy="8"
        r={ringRadius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray={ringCircumference}
        strokeDashoffset={ringOffset(fraction, ringCircumference)}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dashoffset] duration-150 motion-reduce:transition-none"
      />
    </svg>
  )
}

/**
 * The context used, always as text, beside a ring filled to the share of the window when both are
 * known: an arc on a faint track from twelve o'clock, still, coloured by how full. The exact tokens
 * and where the window came from are in the tooltip.
 */
function ContextGauge({ meter }: { meter: ContextMeter }) {
  return (
    <span
      tabIndex={0}
      title={meter.title}
      aria-label={meter.title}
      className="flex h-8 shrink-0 items-center gap-2 rounded-full px-2.5 text-[12.5px] outline-none transition-colors duration-100 hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
    >
      {meter.fraction !== null && <Ring fraction={meter.fraction} tone={meter.tone} />}
      <span className={`tabular-nums ${meter.tone === 'normal' ? 'text-ink-300' : toneText[meter.tone]}`}>{meter.text}</span>
    </span>
  )
}

// Placeholders the size of the controls they stand for, so nothing moves when the settings arrive.
const shimmer = 'animate-pulse rounded-full bg-white/[0.08] motion-reduce:animate-none'

function PickerSkeleton() {
  return (
    <span aria-hidden="true" className="flex h-8 w-[140px] shrink-0 items-center px-3">
      <span className={`h-3 w-full ${shimmer}`} />
    </span>
  )
}

function LimitSkeleton({ window }: { window: string }) {
  return (
    <span aria-hidden="true" className="flex h-6 min-w-0 items-center gap-2">
      <span className="shrink-0 font-medium text-ink-200">{windowNames[window] ?? window}</span>
      <span className={`h-1.5 w-16 shrink-0 ${shimmer}`} />
      <span className={`h-2.5 w-[72px] shrink-0 ${shimmer}`} />
    </span>
  )
}

type Open = AnchorRect | null

function Trigger({ ref, agent, label, title, open, onToggle }: { ref: RefObject<HTMLButtonElement | null>; agent: string | null; label: string; title: string; open: boolean; onToggle: (anchor: AnchorRect) => void }) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      onMouseDown={(event) => {
        // Keeps the caret in the box and lets a second click close the open menu.
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onToggle({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
      }}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Model: ${label}`}
      className="flex h-8 min-w-0 shrink items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] pr-2.5 pl-3 text-[12.5px] @max-[480px]/composer:gap-1.5 @max-[480px]/composer:pr-2 @max-[480px]/composer:pl-2.5 text-ink-200 transition-colors duration-100 hover:border-white/[0.14] hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 aria-expanded:border-white/[0.14] aria-expanded:bg-white/[0.09] aria-expanded:text-ink-100 motion-reduce:transition-none"
    >
      {agent !== null && (
        <span aria-hidden="true" className="contents text-ink-400">
          <AgentIcon agent={agent} size={14} />
        </span>
      )}
      {/* In a narrow pane only the agent's mark shows, the name in the tooltip, rather than a cut-off word. */}
      <span className={`min-w-0 truncate ${agent === null ? '' : '@max-[480px]/composer:hidden'}`}>{label}</span>
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
      </svg>
    </button>
  )
}

/**
 * The model picker and the context used, for the composer's toolbar: one pill for the model, its
 * context window and effort, then a ring for the context used of the window. Whatever is unknown
 * stays out; with nothing known it renders nothing.
 */
export function ComposerStatus({
  agent,
  context,
  model,
  effort,
  canSetEffort,
  onPickModel,
}: {
  agent: string | null
  context: { tokens?: number | null; window?: number | null } | undefined
  model: string | null
  effort: string | undefined
  canSetEffort: boolean
  onPickModel: (pick: ModelPick) => void
}) {
  const { settings } = useSettings()
  const [open, setOpen] = useState<Open>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [asking, setAsking] = useState<PendingConfirm | null>(null)
  const registry = settings?.models ?? []
  const models = agentModels(registry, agent)
  const size = contextWindow(context?.window, agent, model, registry)
  const meter = contextMeter(context?.tokens, size)
  const close = useRef(() => setOpen(null)).current
  const menu = usePresence(open)
  const known = model !== null && model !== ''
  const label = pickerLabel(known ? displayName(model, models) : null, known ? (size?.tokens ?? null) : null, effort)
  // Before the first reading, from the cache or the CLI, the picker holds its place.
  const loading = settings === null && agent !== null
  // The context shows whenever the chat runs an agent, as a dash until it reports one.
  if (agent === null && (context?.tokens ?? null) === null) return null
  return (
    <div aria-busy={loading} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      {loading && <PickerSkeleton />}
      {models.length > 0 && <Trigger ref={trigger} agent={agent} label={label} title={known ? `${label}: ${model}${size?.derived === true ? ' (window from the model)' : ''}` : `${label}: the agent picks its default model`} open={open !== null} onToggle={(anchor) => setOpen((current) => (current === null ? anchor : null))} />}
      <ContextGauge meter={meter} />
      {menu.shown !== null && (
        <ModelMenu
          anchor={menu.shown}
          leaving={menu.leaving}
          agent={agent}
          models={models}
          current={known ? model : null}
          window={known ? (size?.tokens ?? null) : null}
          effort={effort}
          native={canSetEffort}
          contextTokens={context?.tokens}
          onPick={(pick) => {
            setOpen(null)
            onPickModel({ ...pick, name: displayName(pick.model, models) })
          }}
          onAsk={(confirm) => {
            setOpen(null)
            setAsking(confirm)
          }}
          onClose={close}
          trigger={trigger.current}
        />
      )}
      <ConfirmDialog confirm={asking} onClose={() => setAsking(null)} />
    </div>
  )
}

/** The width of the element's parent, read before paint and again on every resize; null until it mounts. */
function useParentWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current?.parentElement ?? null
    if (element === null) return
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** The highest limit as a ring and its share; a click opens both windows with their reset times. */
function LimitRing({ agent, limits }: { agent: string; limits: AgentLimit[] }) {
  const [open, setOpen] = useState<Open>(null)
  const menu = usePresence(open)
  const close = useRef(() => setOpen(null)).current
  const trigger = useRef<HTMLButtonElement>(null)
  const highest = highestLimit(limits)
  if (highest === null) return null
  const title = limits.map((limit) => limitTitle(agent, limit)).join('\n')
  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-label={`Usage limits: ${Math.round(highest.usedPercent)}% used`}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onMouseDown={(event) => {
          // Lets a second click close the open popover.
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const anchor = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          setOpen((current) => (current === null ? anchor : null))
        }}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-full px-1.5 transition-colors duration-100 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 aria-expanded:bg-white/[0.08] motion-reduce:transition-none"
      >
        <Ring fraction={highest.usedPercent / 100} tone={highest.tone} />
        <span className={`tabular-nums ${highest.tone === 'normal' ? 'text-ink-300' : toneText[highest.tone]}`}>{`${Math.round(highest.usedPercent)}%`}</span>
      </button>
      {menu.shown !== null && (
        <Popover {...menuLook} anchor={menu.shown} label="Usage limits" leaving={menu.leaving} onClose={close} trigger={trigger.current}>
          <p className={`${heading} pt-1`}>Usage limits</p>
          <div className="flex flex-col px-2 pb-1 text-[12.5px] text-ink-300">
            {limits.map((limit) => (
              <LimitMeter key={limit.window} agent={agent} limit={limit} />
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

/**
 * The agent's 5-hour and weekly limits under the composer, from its left edge, fitted to the pane:
 * two full rows from 1000px, one quiet line below that, a single ring under 560px (limitsLayout).
 */
export function ComposerLimits({ agent }: { agent: string | null }) {
  const { settings, stale, failed } = useSettings()
  const box = useRef<HTMLDivElement>(null)
  // The composer's footer spans the pane, so its width is the pane's.
  const layout = limitsLayout(useParentWidth(box))
  const limits = settings === null || agent === null ? [] : agentLimits(settings.limits.readings, agent)
  const loading = settings === null
  const hidden = agent === null || (!loading && limits.length === 0)
  // The box stays mounted, empty when hidden, so the pane keeps being measured.
  return (
    <div
      ref={box}
      aria-busy={loading}
      title={(stale || failed) && !hidden ? (failed ? 'Last known usage; retrying' : 'Last known usage; refreshing') : undefined}
      className={`flex min-w-0 flex-wrap items-center justify-start whitespace-nowrap text-ink-300 transition-opacity duration-150 motion-reduce:transition-none ${hidden ? '' : layout === 'full' ? 'gap-x-5 px-3 pt-2 text-[12.5px]' : 'gap-x-2 px-3 pt-1.5 text-[11.5px]'} ${stale || failed ? 'opacity-60' : ''}`}
    >
      {hidden || agent === null ? null : loading ? (
        layout === 'full' ? (
          limitWindows.map((window) => <LimitSkeleton key={window} window={window} />)
        ) : (
          <span aria-hidden="true" className={`h-2.5 ${layout === 'ring' ? 'w-10' : 'w-32'} ${shimmer}`} />
        )
      ) : layout === 'full' ? (
        limits.map((limit) => <LimitMeter key={limit.window} agent={agent} limit={limit} />)
      ) : layout === 'compact' ? (
        limits.map((limit, index) => (
          <span key={limit.window} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden="true" className="text-ink-500">·</span>}
            <CompactLimit agent={agent} limit={limit} />
          </span>
        ))
      ) : (
        <LimitRing agent={agent} limits={limits} />
      )}
    </div>
  )
}
