import type { UsageReading } from '@/api/schema'
import { Checkbox } from '@/components/Checkbox'
import { ErrorNote } from '@/components/ui'
import { resetsIn, usageLevel, type UsageLevel } from '@/settings/settings-model'
import { field, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'

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
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-medium text-ink-300">{label}</span>
        <span className="text-ink-100 tabular-nums">{percent === null ? <span className="text-ink-400">unknown</span> : `${percent}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]" role="meter" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <div className={`h-full rounded-full ${barColor[level]}`} style={{ width: `${percent ?? 0}%` }} />
      </div>
      <p className="min-h-4 truncate text-[12px] text-ink-400">{resets ?? reading?.reason ?? ''}</p>
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
    <div className="grid gap-4 rounded-[16px] border border-white/[0.08] bg-ink-900/80 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[14px] font-semibold text-ink-100 capitalize">{provider}</h4>
        <Checkbox checked={enabled} onChange={onToggle}>
          <span className="text-[12.5px] text-ink-300">Live reading</span>
        </Checkbox>
      </div>
      <div className="grid gap-3">
        <Bar label="5 hours" reading={fiveHour} />
        <Bar label="Weekly" reading={weekly} />
      </div>
      {reason !== null && <p className="-mt-2 text-[12px] text-ink-400 italic">{reason}</p>}
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
    <>
      <section className="grid gap-2">
        <h3 className="px-1 text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">Providers</h3>
        {providers.length === 0 ? (
          <p className="px-1 text-[13px] text-ink-400">No readings yet.</p>
        ) : (
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
        )}
      </section>
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
    </>
  )
}
