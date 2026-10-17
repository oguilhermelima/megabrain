import type { KeyboardEvent, PointerEvent } from 'react'
import { percentClass, type AgentUsage, type MeterTone, type UsageMeter } from '@/advanced/usage-limits'
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

// A meter's fill: neutral, the theme's warning and critical tones near the limit, dim when stale.
const fillClass: Record<MeterTone, string> = { normal: 'bg-ink-300', amber: 'bg-warn', red: 'bg-bad', stale: 'bg-ink-600' }

/**
 * One window: its name, a thin meter, the share and how far its reset is. The first of a pool is its
 * most constraining window and reads brighter; the exact reset time is read out and shown on hover.
 */
function MeterRow({ meter, lead }: { meter: UsageMeter; lead: boolean }) {
  const stale = meter.tone === 'stale'
  const share = lead && meter.tone === 'normal' ? 'text-ink-100' : percentClass(meter.tone)
  const exact = meter.resetsAt === null ? null : resetClock(meter.resetsAt)
  return (
    <li
      className="grid h-5 grid-cols-[48px_minmax(0,1fr)_32px_60px] items-center gap-2"
      aria-label={`${meter.label}: ${percent(meter.usedPercent)} used${stale ? ', last known' : ''}${exact === null ? '' : `, resets ${exact}`}`}
      title={exact === null ? undefined : `Resets ${exact}`}
    >
      <span aria-hidden="true" className={`truncate text-[11.5px] ${lead && !stale ? 'text-ink-300' : 'text-ink-500'}`}>
        {meter.label}
      </span>
      <span aria-hidden="true" className={`block overflow-hidden rounded-full bg-white/[0.08] ${lead ? 'h-1.5' : 'h-1'}`}>
        <span className={`block h-full rounded-full ${fillClass[meter.tone]}`} style={{ width: `${Math.max(3, Math.round(meter.usedPercent))}%` }} />
      </span>
      <span aria-hidden="true" className={`text-right text-[12px] tabular-nums ${lead ? 'font-semibold' : ''} ${share}`}>
        {percent(meter.usedPercent)}
      </span>
      <span aria-hidden="true" className="truncate text-right text-[11px] text-ink-500 tabular-nums">
        {meter.reset ?? ''}
      </span>
    </li>
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

const smallButton = 'flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-500 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:bg-white/[0.06] focus-visible:text-ink-100 focus-visible:outline-none'

/**
 * One agent in the popover: its mark and name, then a meter per window, each pool under its name when
 * it has several. A reading that is not fresh says how old it is beside the name; one that is only the
 * last known says why and what to do, under the meters. Editing, a grip moves it and an eye hides it.
 */
export function AgentUsageRow({ usage, focused, edit }: { usage: AgentUsage; focused: boolean; edit: RowEdit | null }) {
  const name = agentLabel(usage.agent)
  const hidden = edit?.hidden === true
  return (
    <section
      data-provider-limits={usage.agent}
      data-hidden={hidden || undefined}
      aria-label={name}
      className={`rounded-[8px] px-3 py-1.5 transition-[background-color,opacity] motion-reduce:transition-none ${edit?.dragging === true ? 'bg-white/[0.08]' : focused ? 'bg-row-hover' : ''} ${hidden ? 'opacity-50' : ''}`}
    >
      <div className="flex h-6 items-center gap-2">
        {edit !== null && (
          <button type="button" data-usage-grip={usage.agent} aria-label={`Move ${name}`} aria-roledescription="drag handle" {...edit.grip} className={`${smallButton} -ml-2 cursor-grab touch-none active:cursor-grabbing`}>
            <GripIcon />
          </button>
        )}
        <span className={`flex ${usage.lapse === null ? '' : 'opacity-60'}`} style={{ color: usage.color }}>
          <AgentIcon agent={usage.agent} size={14} />
        </span>
        <h3 className={`min-w-0 flex-1 truncate text-[12.5px] font-semibold ${usage.lapse === null ? 'text-ink-100' : 'text-ink-300'}`}>{name}</h3>
        {edit === null && usage.age !== null && <span className="shrink-0 text-[11px] text-ink-500">{usage.age}</span>}
        {edit !== null && (
          <button type="button" aria-pressed={!hidden} aria-label={`Show ${name} in the sidebar`} onClick={edit.onToggle} className={`${smallButton} -mr-2`}>
            <EyeIcon hidden={hidden} />
          </button>
        )}
      </div>
      {usage.pools.map((pool) => (
        <div key={pool.bucket ?? ''}>
          {pool.bucket !== null && <p className="truncate pt-1 text-[11px] font-medium text-ink-400">{pool.bucket}</p>}
          <ul>
            {pool.meters.map((meter, index) => (
              <MeterRow key={meter.window} meter={meter} lead={index === 0} />
            ))}
          </ul>
        </div>
      ))}
      {usage.lapse !== null && (
        <p className="truncate pt-0.5 text-[11px] text-ink-500">
          {usage.lapse.cause}
          {usage.lapse.action !== null && <span className="text-ink-400">{` · ${usage.lapse.action}`}</span>}
        </p>
      )}
    </section>
  )
}
