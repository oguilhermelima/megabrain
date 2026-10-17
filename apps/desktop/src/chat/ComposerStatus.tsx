import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react'
import type { Settings } from '@/api/schema'
import type { AnchorRect } from '@/advanced/menu-placement'
import { Popover } from '@/components/Popover'
import { useAgentDefaults } from '@/lib/useAgentDefaults'
import { usePresence } from '@/lib/usePresence'
import {
  agentModels,
  contextMeter,
  contextWindow,
  defaultWindow,
  displayName,
  effortLevels,
  effortHint,
  effortInUse,
  effortName,
  effortStep,
  findModel,
  formatTokens,
  menuGroups,
  modelDescriptor,
  modelWindows,
  pickerLabel,
  switchNeedsConfirm,
  switchTarget,
  type ContextMeter,
  type LimitTone,
} from '@/chat/composer-status'
import { ringOffset } from '@/chat/composer-look'
import { pickerText } from '@/chat/model-picker-look'
import { menuFocusStep } from '@/components/menu-model'
import { AgentIcon } from '@/components/agent-icons'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { appSettings } from '@/lib/app-settings'
import { isStale } from '@/lib/shared-read'

export const toneText: Record<LimitTone, string> = { normal: 'text-ink-400', amber: 'text-warn', red: 'text-bad' }
export const toneBar: Record<LimitTone, string> = { normal: 'bg-ok', amber: 'bg-warn', red: 'bg-bad' }

/** The settings, whether they are older than a fresh read would be, and whether the last read failed. */
export function useSettings(): { settings: Settings | null; stale: boolean; failed: boolean } {
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
}

/** keepOpen leaves the menu up, for the effort slider moving under the pointer or the arrows. */
type MenuPickOptions = { keepOpen?: boolean }

const heading = `px-2 pb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase ${pickerText.heading}`

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
            className={`h-7 min-w-0 truncate rounded-[8px] px-1.5 text-center text-[12.5px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 motion-reduce:transition-none ${option.value === value ? 'bg-white/[0.15] font-medium text-ink-100 shadow-[0_1px_3px_rgba(0,0,0,0.35)]' : `${pickerText.segment} hover:bg-white/[0.06] hover:text-ink-100`}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The effort as a slider: one stop per level the model supports, its full name under it, the level
 * in use raised on a filled track, the chat's own or else the one the agent runs at. A click or an
 * arrow moves it at once and sends the level a moment after the last move, so stepping across does
 * not send every level on the way; Home and End jump.
 */
function EffortSlider({ levels, value, onPick }: { levels: string[]; value: string | undefined; onPick: (level: string) => void }) {
  const [shown, setShown] = useState(value)
  const pending = useRef<{ level: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const send = useRef(onPick)
  send.current = onPick
  const flush = useCallback(() => {
    const held = pending.current
    if (held === null) return
    clearTimeout(held.timer)
    pending.current = null
    send.current(held.level)
  }, [])
  useEffect(() => {
    if (pending.current === null) setShown(value)
  }, [value])
  // A level still waiting when the menu closes is sent then.
  useEffect(() => flush, [flush])
  const move = (level: string) => {
    setShown(level)
    if (pending.current !== null) clearTimeout(pending.current.timer)
    pending.current = level === value ? null : { level, timer: setTimeout(flush, 300) }
  }
  const index = shown === undefined ? -1 : levels.indexOf(shown)
  const columns = { gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }
  // The track runs from the middle of the first column to the middle of the last.
  const inset = `${50 / levels.length}%`
  const filled = levels.length > 1 && index > 0 ? (index / (levels.length - 1)) * 100 : 0
  return (
    <div className="px-1 pt-2 pb-1">
      <p className={heading}>Effort</p>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={index < 0 ? undefined : index}
        aria-valuetext={shown === undefined ? 'Agent default' : effortName(shown)}
        onKeyDown={(event) => {
          const next = effortStep(levels, shown, event.key)
          if (next === null) return
          event.preventDefault()
          move(next)
        }}
        className="rounded-[10px] px-1 pb-1 outline-none focus-visible:ring-1 focus-visible:ring-white/25"
      >
        <div className="relative grid h-7 items-center" style={columns}>
          <span aria-hidden="true" className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/[0.1]" style={{ left: inset, right: inset }}>
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent/70 transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${filled}%` }} />
          </span>
          {levels.map((level, position) => (
            <button key={level} type="button" tabIndex={-1} aria-label={effortName(level)} onClick={() => move(level)} className="relative z-[1] flex h-7 items-center justify-center">
              <span
                aria-hidden="true"
                className={`rounded-full transition-[width,height,background-color] duration-150 motion-reduce:transition-none ${position === index ? 'size-3.5 bg-ink-100 shadow-[0_1px_3px_rgba(0,0,0,0.45)]' : position < index ? 'size-2 bg-accent' : 'size-2 bg-white/[0.22]'}`}
              />
            </button>
          ))}
        </div>
        <div className="grid" style={columns}>
          {levels.map((level, position) => (
            <span key={level} className={`text-center text-[11.5px] leading-4 whitespace-nowrap ${position === index ? 'font-medium text-ink-100' : pickerText.effortLabel}`}>
              {effortName(level)}
            </span>
          ))}
        </div>
      </div>
      {/* What the level in use means; nothing is in use only when neither the chat, the agent nor the model says. */}
      <p aria-live="polite" className={`mt-1.5 px-1 text-[12px] leading-4 ${pickerText.effortHint}`}>
        {shown !== undefined ? effortHint(shown) : 'The agent picks the effort'}
      </p>
    </div>
  )
}

function ModelRow({ item, checked, onPick }: { item: Models[number]; checked: boolean; onPick: () => void }) {
  const name = displayName(item.model, [item])
  const hint = modelDescriptor(item)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-picker-item=""
      title={item.model}
      onClick={onPick}
      // One height with or without a hint, so the list stays even.
      className={`flex min-h-[50px] w-full items-center gap-3 rounded-[10px] px-2.5 py-1.5 text-left transition-colors duration-100 focus-visible:outline-none motion-reduce:transition-none ${checked ? 'bg-accent/[0.14] hover:bg-accent/[0.18] focus-visible:bg-accent/[0.2]' : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.08]'}`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13.5px] leading-5 ${checked ? `font-semibold ${pickerText.selectedName}` : `font-medium ${pickerText.name}`}`}>{name}</span>
        {hint !== null && <span className={`block truncate text-[12px] leading-4 ${checked ? pickerText.selectedHint : pickerText.hint}`}>{hint}</span>}
      </span>
      <span aria-hidden="true" className={`grid size-5 shrink-0 place-items-center rounded-full ${checked ? 'bg-accent text-accent-ink' : ''}`}>
        {checked && (
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        )}
      </span>
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
  configuredEffort,
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
  /** The effort the agent's own config sets, which the chat runs at when it set none. */
  configuredEffort: string | null
  /** True for a native chat, which sets effort itself; a session takes it by command when its agent has one. */
  native: boolean
  contextTokens: number | null | undefined
  onPick: (pick: ModelPick, options?: MenuPickOptions) => void
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

  const choose = (pick: ModelPick) => {
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
    const windows = modelWindows(item, agent)
    // Another model starts on 1M wherever it supports it.
    const target = switchTarget(item.model, windows, defaultWindow(windows))
    // Effort carries over to a model that has the same level.
    choose({ ...target, effort: effort !== undefined && item.reasoning.levels.includes(effort) ? effort : undefined })
  }
  const row = (item: Models[number]) => <ModelRow key={item.model} item={item} checked={item === entry} onPick={() => pickModel(item)} />
  // Up and down walk the models and the Older toggle, wrapping; Home and End jump. The effort slider keeps its own arrows.
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.hasAttribute('data-picker-item')) return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-picker-item]')]
    const next = menuFocusStep(items.length, items.indexOf(target), event.key)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <Popover {...menuLook} anchor={anchor} label="Model" leaving={leaving} onClose={onClose} trigger={trigger}>
      <div className="w-[340px] max-w-[calc(100vw-32px)]" onKeyDown={walk}>
        <>
          <p className={`${heading} pt-1`}>Model</p>
          {groups.current.map(row)}
          {groups.selected !== null && row(groups.selected)}
          {groups.older.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={showOlder}
                data-picker-item=""
                onClick={() => setShowOlder((open) => !open)}
                className={`mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-[10px] px-2.5 text-left text-[12.5px] font-medium ${pickerText.olderToggle} transition-colors duration-100 hover:bg-white/[0.05] hover:text-ink-200 focus-visible:bg-white/[0.07] focus-visible:text-ink-200 focus-visible:outline-none motion-reduce:transition-none`}
              >
                <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${showOlder ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 4 4 4-4 4" />
                </svg>
                Older models
                <span className="ml-auto rounded-full bg-white/[0.07] px-1.5 text-[11px] leading-[18px] tabular-nums">{groups.older.length}</span>
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
            <EffortSlider levels={levels} value={effortInUse(effort, entry, configuredEffort)} onPick={(level) => onPick({ model: current, window: currentWindow, effort: level }, { keepOpen: true })} />
          )}
        </>
      </div>
    </Popover>
  )
}

const ringRadius = 6
const ringCircumference = 2 * Math.PI * ringRadius

/** A ring filled to a share: an arc on a faint track from twelve o'clock, still, coloured by tone. */
export function Ring({ fraction, tone }: { fraction: number; tone: LimitTone }) {
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
      className="flex h-8 shrink-0 items-center gap-2 rounded-full px-2.5 text-[12.5px] outline-none @max-[560px]/composer:px-2 transition-colors duration-100 hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
    >
      {meter.fraction !== null && <Ring fraction={meter.fraction} tone={meter.tone} />}
      {/* In a narrow pane the ring alone stands for it, the figures in the tooltip, so the toolbar keeps one row. */}
      <span className={`tabular-nums ${meter.tone === 'normal' ? 'text-ink-300' : toneText[meter.tone]} ${meter.fraction === null ? '' : '@max-[560px]/composer:hidden'}`}>{meter.text}</span>
    </span>
  )
}

// Placeholders the size of the controls they stand for, so nothing moves when the settings arrive.
export const shimmer = 'animate-pulse rounded-full bg-white/[0.08] motion-reduce:animate-none'

function PickerSkeleton() {
  return (
    <span aria-hidden="true" className="flex h-8 w-[140px] shrink-0 items-center px-3">
      <span className={`h-3 w-full ${shimmer}`} />
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
  const defaults = useAgentDefaults()
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
  const configuredEffort = defaults?.agents.find((entry) => entry.agent === agent)?.effort ?? null
  // Unset, the chip shows the effort the agent will run at, not none.
  const label = pickerLabel(known ? displayName(model, models) : null, known ? (size?.tokens ?? null) : null, effortInUse(effort, findModel(models, model), configuredEffort))
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
          configuredEffort={configuredEffort}
          native={canSetEffort}
          contextTokens={context?.tokens}
          onPick={(pick, options) => {
            if (options?.keepOpen !== true) setOpen(null)
            onPickModel(pick)
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
