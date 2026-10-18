import type { KeyboardEvent, PointerEvent } from 'react'
import { Chevron } from '@/advanced/chrome'
import { mostUsed } from '@/advanced/usage-collapse'
import { closestToLimit, fillClass, percentClass, type AgentUsage, type MeterTone, type UsageMeter, type UsagePool } from '@/advanced/usage-limits'
import { agentColor } from '@/components/agent-activity'
import { AgentIcon } from '@/components/agent-icons'
import { agentLabel } from '@/native-chat/empty-chat'

// The sidebar's usage readout: the item per agent in its foot, and the row per agent in the popover
// that opens from it.

const percent = (usedPercent: number) => `${Math.round(usedPercent)}%`

const resetClock = (at: Date) => at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** An agent in the sidebar's foot: its mark in its own colour and the share of its most constraining window. */
export function UsageFooterItem({ usage }: { usage: AgentUsage }) {
  const stale = usage.lead.tone === 'stale'
  return (
    <>
      <span className={`flex ${stale ? 'opacity-60' : ''}`} style={{ color: usage.color }}>
        <AgentIcon agent={usage.agent} size={13} />
      </span>
      <span className={`tabular-nums ${percentClass(usage.lead.tone)}`}>{percent(usage.lead.usedPercent)}</span>
    </>
  )
}

// A share's figure: bright when there is room, the tone's colour near the limit.
const valueClass = (tone: MeterTone) => (tone === 'normal' ? 'text-ink-100' : percentClass(tone))

/**
 * One window: its name and the share used on one line, a meter under them, and when it resets in
 * plain words under that. Every window reads at the same weight; a last-known one says so.
 */
function MeterRow({ meter }: { meter: UsageMeter }) {
  const stale = meter.tone === 'stale'
  const exact = meter.resetsAt === null ? null : resetClock(meter.resetsAt)
  const note = [meter.reset, stale ? 'Last known' : null].filter((part) => part !== null).join(' · ')
  return (
    <li
      className="py-1"
      aria-label={`${meter.label}: ${percent(meter.usedPercent)} used${stale ? ', last known' : ''}${exact === null ? '' : `, resets ${exact}`}`}
      title={exact === null ? undefined : `Resets ${exact}`}
    >
      <div aria-hidden="true" className="flex h-5 items-center justify-between gap-2">
        <span className="truncate text-[12px] text-ink-200">{meter.label}</span>
        <span className="shrink-0 tabular-nums">
          <span className={`text-[12.5px] font-semibold ${valueClass(meter.tone)}`}>{percent(meter.usedPercent)}</span>
          <span className="text-[11px] text-ink-400"> used</span>
        </span>
      </div>
      <span aria-hidden="true" className="mt-1 block h-2 overflow-hidden rounded-full bg-white/[0.1]">
        <span className={`block h-full rounded-full ${fillClass(meter.tone)}`} style={{ width: `${Math.max(2, Math.min(100, Math.round(meter.usedPercent)))}%` }} />
      </span>
      {note !== '' && (
        <p aria-hidden="true" className="mt-1 truncate text-[11px] text-ink-400 tabular-nums">
          {note}
        </p>
      )}
    </li>
  )
}

/** A folded row's window: its share as a figure beside a short meter, and in words for a screen reader. */
function MeterSummary({ meter }: { meter: UsageMeter }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="sr-only">{`, ${meter.label} ${percent(meter.usedPercent)} used${meter.tone === 'stale' ? ', last known' : ''}`}</span>
      <span aria-hidden="true" className="block h-1.5 w-12 overflow-hidden rounded-full bg-white/[0.1]">
        <span className={`block h-full rounded-full ${fillClass(meter.tone)}`} style={{ width: `${Math.max(4, Math.min(100, Math.round(meter.usedPercent)))}%` }} />
      </span>
      <span aria-hidden="true" className={`w-9 text-right text-[12px] font-semibold tabular-nums ${valueClass(meter.tone)}`}>
        {percent(meter.usedPercent)}
      </span>
    </span>
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

export interface RowEdit {
  hidden: boolean
  dragging: boolean
  onToggle: () => void
  grip: {
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  }
}

/** What the popover folds: the provider to one row, and each of its named pools to its name. */
export interface RowFold {
  collapsed: boolean
  onToggle: () => void
  poolCollapsed: (pool: UsagePool) => boolean
  onTogglePool: (pool: UsagePool) => void
}

const foldButton = 'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

const smallButton = 'flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-500 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:text-ink-100 focus-visible:outline-none'

/**
 * One agent in the popover: its mark and name, then a meter per window, each pool nested under its name
 * when it has several. A reading that is not fresh says when it was updated beside the name; one that is
 * only the last known says why and what to do, under the meters. Editing, a grip moves it and an eye hides it.
 * Folded, it is one row with its most used window; a folded pool is its name and its own most used one.
 */
export function AgentUsageRow({ usage, focused, edit, fold }: { usage: AgentUsage; focused: boolean; edit: RowEdit | null; fold: RowFold }) {
  const name = agentLabel(usage.agent)
  const hidden = edit?.hidden === true
  const collapsed = fold.collapsed
  return (
    <section
      data-provider-limits={usage.agent}
      data-hidden={hidden || undefined}
      aria-label={name}
      className={`rounded-[8px] px-3 ${collapsed ? 'py-1' : 'py-2'} transition-[background-color,opacity] motion-reduce:transition-none ${edit?.dragging === true ? 'bg-white/[0.08]' : focused ? 'bg-row-hover' : ''} ${hidden ? 'opacity-50' : ''}`}
    >
      <div className="flex h-6 items-center gap-2">
        {edit !== null && (
          <button type="button" data-usage-grip={usage.agent} aria-label={`Move ${name}`} aria-roledescription="drag handle" {...edit.grip} className={`${smallButton} -ml-2 cursor-grab touch-none active:cursor-grabbing`}>
            <GripIcon />
          </button>
        )}
        <h3 className="flex min-w-0 flex-1 self-stretch">
          <button type="button" aria-expanded={!collapsed} onClick={fold.onToggle} className={foldButton}>
            <span className="-ml-1 flex shrink-0 text-ink-500">
              <Chevron open={!collapsed} />
            </span>
            <span className={`flex ${usage.lapse === null ? '' : 'opacity-60'}`} style={{ color: usage.color }}>
              <AgentIcon agent={usage.agent} size={14} />
            </span>
            <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${usage.lapse === null ? 'text-ink-100' : 'text-ink-300'}`}>{name}</span>
            {collapsed ? <MeterSummary meter={usage.lead} /> : edit === null && usage.age !== null && <span className="shrink-0 text-[10.5px] font-normal text-ink-500">{`Updated ${usage.age}`}</span>}
          </button>
        </h3>
        {edit !== null && (
          <button type="button" aria-pressed={!hidden} aria-label={`Show ${name} in the sidebar`} onClick={edit.onToggle} className={`${smallButton} -mr-2`}>
            <EyeIcon hidden={hidden} />
          </button>
        )}
      </div>
      {!collapsed &&
        usage.pools.map((pool) => {
          const folded = fold.poolCollapsed(pool)
          const lead = mostUsed(pool.meters)
          return (
            // A pool of several hangs off the agent on a rule, so it reads as part of it rather than a provider.
            <div key={pool.bucket ?? ''} className={pool.bucket === null ? '' : 'mt-1.5 ml-[6px] border-l border-white/[0.1] pl-3'}>
              {pool.bucket !== null && (
                <h4 className="flex h-5">
                  <button type="button" aria-expanded={!folded} onClick={() => fold.onTogglePool(pool)} className={foldButton}>
                    <span className="-ml-1 flex shrink-0 text-ink-500">
                      <Chevron open={!folded} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-400">{pool.bucket}</span>
                    {folded && lead !== null && <MeterSummary meter={lead} />}
                  </button>
                </h4>
              )}
              {!folded && (
                <ul>
                  {pool.meters.map((meter) => (
                    <MeterRow key={meter.window} meter={meter} />
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      {!collapsed && usage.lapse !== null && (
        <p className="truncate pt-0.5 text-[11px] text-ink-500">
          {usage.lapse.cause}
          {usage.lapse.action !== null && <span className="text-ink-400">{` · ${usage.lapse.action}`}</span>}
        </p>
      )}
    </section>
  )
}

/** The window nearest its limit across every agent, one line above the cards; nothing when none is current. */
export function ClosestLimitLine({ usage }: { usage: AgentUsage[] }) {
  const closest = closestToLimit(usage)
  if (closest === null) return null
  const where = [agentLabel(closest.agent), closest.bucket, closest.meter.label].filter((part) => part !== null).join(' · ')
  return (
    <p data-usage-closest="" className="mx-1 mb-1 flex items-center gap-2 rounded-[8px] bg-white/[0.04] px-2 py-1.5 text-[11.5px]">
      <span className="flex shrink-0" style={{ color: agentColor(closest.agent) }}>
        <AgentIcon agent={closest.agent} size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-300">
        <span className="text-ink-500">Closest </span>
        {where}
      </span>
      <span className={`shrink-0 font-semibold tabular-nums ${valueClass(closest.meter.tone)}`}>{`${percent(closest.meter.usedPercent)} used`}</span>
    </p>
  )
}
