import type { UsageReading } from '@/api/schema'
import { Check, ErrorNote } from '@/components/ui'
import { resetsIn, usageLevel, type UsageLevel } from '@/settings/settings-model'

const barColor: Record<UsageLevel, string> = {
  normal: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-bad',
  unknown: 'bg-ink-700',
}

function Bar({ label, reading }: { label: string; reading: UsageReading | null }) {
  const percent = reading?.usedPercent ?? null
  const level = usageLevel(percent)
  const resets = reading === null ? null : resetsIn(reading.resetsAt)
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-semibold text-ink-300">{label}</span>
        <span className="text-ink-400">{percent === null ? 'unknown' : `${percent}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
        <div className={`h-full rounded-full ${barColor[level]}`} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="truncate text-[12px] text-ink-500">{resets ?? (reading?.reason ?? '')}</p>
    </div>
  )
}

export function UsageCard({
  provider,
  fiveHour,
  weekly,
  enabled,
  onToggle,
}: {
  provider: string
  fiveHour: UsageReading | null
  weekly: UsageReading | null
  enabled: boolean
  onToggle: (enabled: boolean) => void
}) {
  const reason = fiveHour?.status === 'unknown' ? fiveHour.reason : weekly?.status === 'unknown' ? weekly.reason : null
  return (
    <div className="rounded-[20px] border border-white/[0.08] bg-ink-900 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-[14px] font-semibold text-ink-100 capitalize">{provider}</h4>
        <Check checked={enabled} onChange={onToggle}>
          <span className="text-[12.5px] text-ink-400">Live reading</span>
        </Check>
      </div>
      <div className="mt-3 grid gap-3">
        <Bar label="5h" reading={fiveHour} />
        <Bar label="weekly" reading={weekly} />
      </div>
      {reason !== null && <p className="mt-2 text-[12px] text-ink-500 italic">{reason}</p>}
    </div>
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
}: {
  providers: { provider: string; fiveHour: UsageReading | null; weekly: UsageReading | null }[]
  enabledProviders: string[]
  noticeEnabled: boolean
  noticeIntervalMinutes: number
  error: unknown
  onToggleProvider: (provider: string, enabled: boolean) => void
  onToggleNotice: (enabled: boolean) => void
  onChangeInterval: (minutes: number) => void
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {providers.map((group) => (
          <UsageCard
            key={group.provider}
            provider={group.provider}
            fiveHour={group.fiveHour}
            weekly={group.weekly}
            enabled={enabledProviders.includes(group.provider)}
            onToggle={(enabled) => onToggleProvider(group.provider, enabled)}
          />
        ))}
      </div>
      <div className="rounded-[20px] border border-white/[0.08] bg-ink-900 p-4">
        <Check checked={noticeEnabled} onChange={onToggleNotice}>
          <span className="text-[13px] text-ink-200">Limit notices</span>
        </Check>
        <label className="mt-2 flex items-center gap-2 px-3 text-[12.5px] text-ink-400">
          Check every
          <input
            type="number"
            min={1}
            disabled={!noticeEnabled}
            value={noticeIntervalMinutes}
            onChange={(event) => onChangeInterval(Number(event.target.value))}
            className="w-20 rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-ink-100 disabled:opacity-50"
          />
          minutes
        </label>
      </div>
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}
