import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { UsageReading, UsageStats } from '@/api/schema'
import { AgentIcon } from '@/components/agent-icons'
import { Bone } from '@/components/Skeleton'
import { Button, ErrorNote, Segmented, Spinner } from '@/components/ui'
import { resetsIn, usageLevel, type ProviderReadings, type UsageLevel } from '@/settings/settings-model'
import { field, quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'
import {
  formatCost,
  formatDay,
  formatMonthDay,
  formatDuration,
  formatPercent,
  formatTokens,
  HEATMAP_WEEKS,
  heatmap,
  providerCards,
  rangeDays,
  tokenMix,
  type HeatCell,
  type ProviderCard,
  type TokenKind,
  type UsageRange,
} from '@/settings/usage-model'

// Colours for data only, from the dataviz reference palette's dark steps, checked against this
// window's surface with its validator (all five pass; worst adjacent CVD ΔE 8.4). Categorical slots
// go in this fixed order and follow the thing they stand for: a token kind or a provider keeps its
// colour whatever else is shown. Text never takes these; it stays in the ink tokens.
const kindColor: Record<TokenKind, string> = { input: '#3987e5', output: '#d95926', cacheRead: '#199e70', cacheWrite: '#c98500', reasoning: '#d55181' }
const providerColor: Record<string, string> = { claude: '#3987e5', codex: '#d95926', grok: '#199e70', agy: '#c98500' }
// One hue, dark to light: on a dark surface the brightest cell is the busiest day.
const heatColor = ['rgb(255 255 255 / 0.06)', '#184f95', '#256abf', '#3987e5', '#86b6ef'] as const

const barColor: Record<UsageLevel, string> = { normal: 'bg-ok', amber: 'bg-warn', red: 'bg-bad', unknown: 'bg-ink-700' }

const rangeOptions: { value: UsageRange; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: 'all', label: 'All' },
]

const rangeKey = 'megabrain.settings.usage-range'

function rememberedRange(): UsageRange {
  try {
    const value = localStorage.getItem(rangeKey)
    return rangeOptions.some((option) => option.value === value) ? (value as UsageRange) : '30'
  } catch {
    return '30'
  }
}

type Load = { status: 'loading' | 'ready' | 'error'; value: UsageStats | null; error: unknown }

/** One `usage stats` read; a reload keeps the last report on screen while it runs. */
function useStats(days: number | null, generation: number): Load {
  const [load, setLoad] = useState<Load>({ status: 'loading', value: null, error: null })
  useEffect(() => {
    let stopped = false
    setLoad((current) => ({ ...current, status: 'loading' }))
    api.usageStats(days).then(
      (value) => !stopped && setLoad({ status: 'ready', value, error: null }),
      (error: unknown) => !stopped && setLoad((current) => ({ status: 'error', value: current.value, error })),
    )
    return () => {
      stopped = true
    }
  }, [days, generation])
  return load
}

function Panel({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`grid content-start gap-3 rounded-[16px] border border-white/[0.08] bg-ink-900/80 p-4 ${className}`}>
      <header className="flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** A label over a number; a bone while it loads. */
function Metric({ label, value, detail, loading, large = false }: { label: string; value: string | null; detail?: string | null; loading: boolean; large?: boolean }) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <p className="truncate text-[12px] text-ink-400">{label}</p>
      {loading && value === null ? (
        <Bone width="w-[70%]" className={large ? 'my-1 h-5' : 'my-0.5 h-4'} />
      ) : (
        <p className={`truncate font-semibold text-ink-100 tabular-nums ${large ? 'text-[22px] tracking-[-0.02em]' : 'text-[17px]'}`}>{value ?? '—'}</p>
      )}
      {detail !== undefined && <p className="min-h-4 text-[11.5px] leading-snug text-ink-500">{detail}</p>}
    </div>
  )
}

function StatCard({ label, value, detail, loading }: { label: string; value: string | null; detail?: string | null; loading: boolean }) {
  return (
    <div className="rounded-[16px] border border-white/[0.08] bg-ink-900/80 px-4 py-3.5">
      <Metric label={label} value={value} detail={detail} loading={loading} large />
    </div>
  )
}

function rangeText(stats: UsageStats | null, range: UsageRange): string {
  if (range === 'all') return stats?.range.from === null || stats === null ? 'All time' : `Since ${formatDay(stats.range.from)}`
  return `Last ${range} days`
}

function MixBar({ stats, loading }: { stats: UsageStats | null; loading: boolean }) {
  const segments = stats === null ? [] : tokenMix(stats.totals)
  if (stats === null) return loading ? <Bone width="w-full" className="h-3" /> : null
  if (segments.length === 0) return <p className="text-[13px] text-ink-400">No tokens in this range.</p>
  return (
    <div className="grid gap-3">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={segments.map((segment) => `${segment.label} ${formatPercent(segment.share)}`).join(', ')}>
        {segments.map((segment) => (
          <span key={segment.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${segment.share * 100}%`, minWidth: 3, background: kindColor[segment.key] }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-1.5 text-[12px] text-ink-300">
            <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ background: kindColor[segment.key] }} />
            {segment.label}
            <span className="text-ink-100 tabular-nums">{formatTokens(segment.value)}</span>
            <span className="text-ink-500 tabular-nums">{formatPercent(segment.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const weekdayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', '']

function Heatmap({ stats, loading }: { stats: UsageStats | null; loading: boolean }) {
  const [hovered, setHovered] = useState<HeatCell | null>(null)
  if (stats === null) return loading ? <Bone width="w-full" className="h-28 rounded-[10px]" /> : null
  const map = heatmap(stats.daily, stats.range.to)
  const readout = hovered ?? (map.best === null ? null : { ...map.best, level: 4 as const })
  return (
    <div className="grid gap-3">
      <div className="flex gap-1.5">
        <div className="grid shrink-0 grid-rows-7 gap-[3px] pr-0.5" aria-hidden="true">
          {weekdayLabels.map((label, index) => (
            <span key={index} className="flex items-center text-[10px] leading-none text-ink-500">
              {label}
            </span>
          ))}
        </div>
        <div
          className="grid min-w-0 flex-1 grid-flow-col grid-rows-7 gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${map.weeks.length}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`Tokens per day over the last ${HEATMAP_WEEKS} weeks${map.best === null ? '' : `; busiest ${formatDay(map.best.date)} with ${formatTokens(map.best.total)}`}`}
          onMouseLeave={() => setHovered(null)}
        >
          {map.weeks.flat().map((cell, index) =>
            cell === null ? (
              <span key={index} />
            ) : (
              <span
                key={cell.date}
                onMouseEnter={() => setHovered(cell)}
                className={`aspect-square rounded-[3px] ${hovered?.date === cell.date ? 'ring-1 ring-ink-100' : ''}`}
                style={{ background: heatColor[cell.level] }}
              />
            ),
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <p className="min-h-4 text-ink-300 tabular-nums">
          {readout === null ? (
            <span className="text-ink-500">No activity yet.</span>
          ) : (
            <>
              <span className="text-ink-500">{hovered === null ? 'Best day ' : ''}</span>
              {formatDay(readout.date)} · <span className="text-ink-100">{formatTokens(readout.total)}</span> tokens
            </>
          )}
        </p>
        <div className="flex items-center gap-1 text-ink-500" aria-hidden="true">
          Less
          {heatColor.map((color) => (
            <span key={color} className="size-2.5 rounded-[3px]" style={{ background: color }} />
          ))}
          More
        </div>
      </div>
    </div>
  )
}

function LimitBar({ label, reading }: { label: string; reading: UsageReading | null }) {
  const percent = reading?.usedPercent ?? null
  const resets = reading === null ? null : resetsIn(reading.resetsAt)
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-ink-400">{label}</span>
        <span className="text-ink-100 tabular-nums">{percent === null ? <span className="text-ink-500">unknown</span> : `${percent}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]" role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <div className={`h-full rounded-full ${barColor[usageLevel(percent)]}`} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="min-h-4 truncate text-[11.5px] text-ink-500">{resets ?? reading?.reason ?? ''}</p>
    </div>
  )
}

const providerLabel: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'agy' }

const folder = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

function ProviderPanel({ card, loading, onToggle }: { card: ProviderCard; loading: boolean; onToggle: (enabled: boolean) => void }) {
  const usage = card.usage
  const hasLimits = card.fiveHour !== null || card.weekly !== null
  return (
    <section className="grid content-start gap-3 rounded-[16px] border border-white/[0.08] bg-ink-900/80 p-4" aria-label={card.provider}>
      <header className="flex items-center gap-2">
        <AgentIcon agent={card.provider} size={16} className="text-ink-200" />
        <h4 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-100">{providerLabel[card.provider] ?? card.provider}</h4>
        <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium ${card.liveEnabled ? 'text-ok' : 'text-ink-500'}`}>
          <span aria-hidden="true" className={`size-1.5 rounded-full ${card.liveEnabled ? 'bg-ok' : 'bg-ink-600'}`} />
          {card.liveEnabled ? 'Live' : 'Off'}
        </span>
        <button
          type="button"
          className={`h-7 rounded-full px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${card.liveEnabled ? 'text-ink-300 hover:bg-white/[0.07] hover:text-ink-100' : 'border border-white/15 bg-white/[0.07] text-ink-100 hover:bg-white/[0.12]'}`} aria-label={`${card.liveEnabled ? 'Disable' : 'Enable'} live limits for ${providerLabel[card.provider] ?? card.provider}`} onClick={() => onToggle(!card.liveEnabled)}>
          {card.liveEnabled ? 'Disable' : 'Enable'}
        </button>
      </header>
      {usage === null && loading ? (
        <div className="grid gap-2">
          <Bone width="w-[45%]" className="h-5" />
          <Bone width="w-full" className="h-1.5" />
        </div>
      ) : usage === null ? null : !usage.tracked ? (
        <p className="text-[12.5px] text-ink-400">This agent keeps no token counts in its logs.</p>
      ) : (
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[20px] font-semibold tracking-[-0.02em] text-ink-100 tabular-nums">
              {formatTokens(usage.total)} <span className="text-[12px] font-normal tracking-normal text-ink-400">tokens</span>
            </p>
            <p className="text-[12px] text-ink-400 tabular-nums">{formatPercent(usage.share)} of all</p>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]" role="meter" aria-label={`${card.provider} share of tokens`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.share * 100)}>
            <div className="h-full rounded-full" style={{ width: `${usage.share * 100}%`, background: providerColor[card.provider] ?? '#3987e5' }} />
          </div>
          <dl className="grid grid-cols-3 gap-2 pt-1 text-[12px]">
            <div>
              <dt className="text-ink-500">Sessions</dt>
              <dd className="text-ink-100 tabular-nums">{usage.sessions.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Turns</dt>
              <dd className="text-ink-100 tabular-nums">{usage.turns.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Est. cost</dt>
              <dd className="text-ink-100 tabular-nums">{usage.cost === null && usage.total > 0 ? <span className="text-ink-500">no price</span> : formatCost(usage.cost ?? 0)}</dd>
            </div>
          </dl>
          {usage.lastModel !== null && (
            <p className="truncate text-[12px] text-ink-400">
              <span className="font-mono text-ink-200">{usage.lastModel}</span>
              {usage.lastProject !== null && <> in {folder(usage.lastProject)}</>}
            </p>
          )}
        </div>
      )}
      {hasLimits && (
        <div className="grid gap-2 border-t border-white/[0.06] pt-3">
          <LimitBar label="5 hours" reading={card.fiveHour} />
          <LimitBar label="Weekly" reading={card.weekly} />
        </div>
      )}
    </section>
  )
}

function TopList({ rows, empty }: { rows: { key: string; label: ReactNode; total: number; detail?: string }[]; empty: string }) {
  if (rows.length === 0) return <p className="text-[13px] text-ink-400">{empty}</p>
  const max = Math.max(...rows.map((row) => row.total), 1)
  return (
    <ul className="grid gap-2.5">
      {rows.map((row) => (
        <li key={row.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 truncate text-ink-200">{row.label}</span>
            <span className="shrink-0 text-ink-100 tabular-nums">
              {formatTokens(row.total)}
              {row.detail !== undefined && <span className="ml-2 text-ink-500">{row.detail}</span>}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.05]">
            <div className="h-full rounded-full bg-ink-400" style={{ width: `${(row.total / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function UsageSection({
  providers,
  enabledProviders,
  noticeEnabled,
  noticeIntervalMinutes,
  error,
  onToggleProvider,
  onToggleNotice,
  onChangeInterval,
  onRefreshLimits,
}: {
  providers: ProviderReadings[]
  enabledProviders: string[]
  noticeEnabled: boolean
  noticeIntervalMinutes: number
  error: unknown
  onToggleProvider: (provider: string, enabled: boolean) => void
  onToggleNotice: (enabled: boolean) => void
  onChangeInterval: (minutes: number) => void
  /** Re-reads the live limit readings. */
  onRefreshLimits: () => Promise<void>
}) {
  const [range, setRange] = useState<UsageRange>(rememberedRange)
  const [generation, setGeneration] = useState(0)
  const [refreshingLimits, setRefreshingLimits] = useState(false)
  const stats = useStats(rangeDays[range], generation)
  // The heatmap keeps its weeks whatever the range, from a read of its own.
  const heat = useStats(HEATMAP_WEEKS * 7, generation)
  const report = stats.value
  const loading = stats.status === 'loading'

  const pick = (next: UsageRange) => {
    setRange(next)
    try {
      localStorage.setItem(rangeKey, next)
    } catch {
      // Remembering the range is a convenience.
    }
  }

  const refresh = useCallback(async () => {
    setGeneration((value) => value + 1)
    setRefreshingLimits(true)
    try {
      await onRefreshLimits()
    } finally {
      setRefreshingLimits(false)
    }
  }, [onRefreshLimits])

  const busy = loading || heat.status === 'loading' || refreshingLimits
  const cards = providerCards(report?.providers ?? null, providers, enabledProviders)
  const megabrain = report?.megabrain ?? null
  const totals = report?.totals ?? null

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={range} options={rangeOptions} onChange={pick} />
        <button type="button" className={quiet} disabled={busy} onClick={() => void refresh()}>
          {busy ? (
            <Spinner />
          ) : (
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
            </svg>
          )}
          Refresh
        </button>
      </div>

      {stats.status === 'error' && (
        <div className="grid justify-items-start gap-2">
          <ErrorNote error={stats.error} />
          <Button className="h-8 px-4 text-[13px]" onClick={() => setGeneration((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Agents spawned" value={megabrain === null ? null : megabrain.dispatches.toLocaleString()} detail={rangeText(report, range)} loading={loading} />
        <StatCard label="Agent time" value={megabrain === null ? null : formatDuration(megabrain.agentSeconds)} detail="by dispatches" loading={loading} />
        <StatCard label="Chats" value={megabrain === null ? null : megabrain.chats.toLocaleString()} detail="started in the app" loading={loading} />
        <StatCard
          label="Tracking since"
          value={report?.trackingSince == null ? null : formatMonthDay(report.trackingSince)}
          detail={report?.trackingSince == null ? null : report.trackingSince.slice(0, 4)}
          loading={loading}
        />
      </div>

      <Panel title="Overview" aside={<span className="text-[12px] text-ink-500">{rangeText(report, range)}</span>}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Total tokens" value={totals === null ? null : formatTokens(totals.total)} detail={totals === null ? null : `${totals.sessions.toLocaleString()} sessions · ${totals.turns.toLocaleString()} turns`} loading={loading} />
          <Metric label="Est. cost" value={totals === null ? null : formatCost(totals.cost ?? 0)} detail={totals === null || totals.unpricedTokens === 0 ? 'API list prices' : `${formatTokens(totals.unpricedTokens)} tokens unpriced`} loading={loading} />
          <Metric label="Active days" value={report === null ? null : report.activeDays.toLocaleString()} detail={report?.bestDay == null ? null : `best ${formatDay(report.bestDay.date)}`} loading={loading} />
          <Metric label="Cache share" value={report === null ? null : report.cacheShare === null ? '—' : formatPercent(report.cacheShare)} detail="of input read from cache" loading={loading} />
        </div>
      </Panel>

      <Panel title="Daily intensity" aside={<span className="text-[12px] text-ink-500">Last {HEATMAP_WEEKS} weeks</span>}>
        {heat.status === 'error' && heat.value === null ? <ErrorNote error={heat.error} /> : <Heatmap stats={heat.value} loading={heat.status === 'loading'} />}
      </Panel>

      <Panel title="Token mix">
        <MixBar stats={report} loading={loading} />
      </Panel>

      <section className="grid gap-2">
        <h3 className="px-1 text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">Providers</h3>
        {cards.length === 0 ? (
          <p className="px-1 text-[13px] text-ink-400">{loading ? 'Reading usage…' : 'No providers yet.'}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <ProviderPanel key={card.provider} card={card} loading={loading} onToggle={(enabled) => onToggleProvider(card.provider, enabled)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <Panel title="Top models">
          {report === null ? (
            <Bone width="w-full" className="h-16 rounded-[10px]" />
          ) : (
            <TopList
              rows={report.models.slice(0, 5).map((model) => ({ key: `${model.provider}/${model.model}`, label: <span className="font-mono text-[12px]">{model.model}</span>, total: model.total, detail: model.cost === null ? undefined : formatCost(model.cost) }))}
              empty="No models in this range."
            />
          )}
        </Panel>
        <Panel title="Top projects">
          {report === null ? <Bone width="w-full" className="h-16 rounded-[10px]" /> : <TopList rows={report.projects.slice(0, 5).map((project) => ({ key: project.project, label: folder(project.project), total: project.total }))} empty="No projects in this range." />}
        </Panel>
      </div>

      <SettingsGroup title="Notices">
        <SettingRow label="Limit notices" description="Tell you when a provider nears its limit.">
          <Switch label="Limit notices" checked={noticeEnabled} onChange={onToggleNotice} />
        </SettingRow>
        <SettingRow label="Check every" description="Minutes between readings while notices are on." htmlFor="notice-interval">
          <input
            id="notice-interval"
            type="number"
            min={1}
            disabled={!noticeEnabled}
            value={noticeIntervalMinutes}
            onChange={(event) => onChangeInterval(Number(event.target.value))}
            className={`${field} w-20 text-right tabular-nums`}
          />
          <span className="text-[12.5px] text-ink-400">min</span>
        </SettingRow>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
      {report !== null && (
        <p className="px-1 text-[11.5px] text-ink-500">
          Costs are estimates at API list prices as of {formatDay(report.prices.asOf)}; subscriptions are billed differently, and models without a list price are left out. Read from the agents’ own logs on this machine.
        </p>
      )}
    </>
  )
}
