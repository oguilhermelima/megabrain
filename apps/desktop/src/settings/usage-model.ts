// What the Usage page shows, from `usage stats --json` and the live limit readings: the heatmap's
// weeks, the token mix, the per-provider cards, and how each number is written in the locale.

import type { UsageStats } from '@/api/schema'
import type { ProviderReadings } from '@/settings/settings-model'

export type UsageRange = '7' | '30' | '90' | 'all'

export const rangeDays: Record<UsageRange, number | null> = { '7': 7, '30': 30, '90': 90, all: null }

/** The heatmap always covers this many weeks, whatever the range, so its shape stays put. */
export const HEATMAP_WEEKS = 26

export type Daily = UsageStats['daily'][number]
export interface HeatCell {
  date: string
  total: number
  /** 0 for no tokens, then 1 to 4 by quartile of the days with tokens. */
  level: 0 | 1 | 2 | 3 | 4
}

const DAY = 86_400_000
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)

/**
 * Whole weeks, Sunday first, ending with the week of `today`; a day after today is null. Levels are
 * quartiles of the days that have tokens, so one very busy day does not flatten the rest.
 */
export function heatmap(daily: readonly Daily[], today: string, weeks = HEATMAP_WEEKS): { weeks: (HeatCell | null)[][]; best: { date: string; total: number } | null } {
  const todayTime = Date.parse(`${today}T00:00:00Z`)
  const start = todayTime - (new Date(todayTime).getUTCDay() + (weeks - 1) * 7) * DAY
  const first = isoDay(start)
  const totals = new Map(daily.filter((day) => day.date >= first && day.date <= today && day.total > 0).map((day) => [day.date, day.total]))
  const ranked = [...totals.values()].sort((a, b) => a - b)
  const levelOf = (total: number): HeatCell['level'] => {
    if (total <= 0) return 0
    return (1 + Math.floor((4 * ranked.indexOf(total)) / ranked.length)) as HeatCell['level']
  }
  let best: { date: string; total: number } | null = null
  for (const [date, total] of totals) if (best === null || total > best.total) best = { date, total }
  const columns = Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const time = start + (week * 7 + weekday) * DAY
      if (time > todayTime) return null
      const date = isoDay(time)
      const total = totals.get(date) ?? 0
      return { date, total, level: levelOf(total) }
    }),
  )
  return { weeks: columns, best }
}

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
export interface MixSegment {
  key: TokenKind
  label: string
  value: number
  share: number
}

// The order is the palette's slot order (kindColor in UsageSection), which keeps neighbours apart for colour-blind readers.
const kinds: { key: TokenKind; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'reasoning', label: 'Reasoning' },
]

export function tokenMix(tokens: Record<TokenKind, number>): MixSegment[] {
  const total = kinds.reduce((sum, kind) => sum + tokens[kind.key], 0)
  if (total === 0) return []
  return kinds.filter((kind) => tokens[kind.key] > 0).map((kind) => ({ ...kind, value: tokens[kind.key], share: tokens[kind.key] / total }))
}

export function formatTokens(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatCost(value: number | null, locale?: string): string {
  return value === null ? '—' : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value)
}

export function formatPercent(share: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: share < 0.1 && share > 0 ? 1 : 0 }).format(share)
}

/** The two largest units: "151d 12h", "5h 20m", "12m". */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** The month and day alone, for a tile with its year beside it. */
export function formatMonthDay(day: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

/** A YYYY-MM-DD day as written in the locale; read in UTC so it stays the same calendar day. */
export function formatDay(day: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
}

export type ProviderUsage = UsageStats['providers'][number]
export interface ProviderCard extends ProviderReadings {
  /** null when the stats are not loaded, or the provider only has live readings. */
  usage: ProviderUsage | null
  liveEnabled: boolean
}

/** One card per provider the stats know, in their order, then any provider that only has live readings. */
export function providerCards(usage: readonly ProviderUsage[] | null, readings: readonly ProviderReadings[], enabled: readonly string[]): ProviderCard[] {
  const names = [...(usage ?? []).map((entry) => entry.provider), ...readings.map((group) => group.provider)].filter((name, index, all) => all.indexOf(name) === index)
  return names.map((name) => {
    const group = readings.find((entry) => entry.provider === name)
    return { provider: name, usage: usage?.find((entry) => entry.provider === name) ?? null, fiveHour: group?.fiveHour ?? null, weekly: group?.weekly ?? null, liveEnabled: enabled.includes(name) }
  })
}
