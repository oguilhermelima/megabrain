import type { UsageReading } from '@/api/schema'
import { limitWindows, parseResetsAt, readingAge, resetDistance, usageLimitTone, type LimitTone } from '@/chat/composer-status'
import { agentColor } from '@/components/agent-activity'

// What the sidebar's usage readout says of each agent: its windows grouped by the pool of models they
// count (agy keeps one for its own models and one for the others), always 5-hour then weekly, and, for
// a reading that is only the last one known, why and what to do about it.

/** A share's tone, or stale for a value that is the last one known: muted, never a warning. */
export type MeterTone = LimitTone | 'stale'

export interface UsageMeter {
  window: string
  /** The window as the person reads it: 5-hour, Weekly, or the id of one the app does not name. */
  label: string
  usedPercent: number
  tone: MeterTone
  resetsAt: Date | null
  /** When the window resets as a phrase, "Resets in 3h 43m" or "Resets Tue 14:00", or null when the reading has no reset time. */
  reset: string | null
}

export interface UsagePool {
  /** The pool's name when the agent has several; null when it has one. */
  bucket: string | null
  /** 5-hour, weekly, then any other in reading order. */
  meters: UsageMeter[]
}

/** Why a reading is only the last one known, and what to do or wait for. */
export interface UsageLapse {
  cause: string
  action: string | null
}

export interface AgentUsage {
  agent: string
  /** The agent's own colour, for its mark. */
  color: string
  pools: UsagePool[]
  /** The most constraining window of every pool, which the sidebar's foot shows. */
  lead: UsageMeter
  /** How old the newest reading is, only when it is not fresh and not stale. */
  age: string | null
  /** Whether that age is past an hour, old enough that the numbers may have moved. */
  aged: boolean
  lapse: UsageLapse | null
}

const windowLabels: Record<string, string> = { '5h': '5-hour', weekly: 'Weekly' }
const windowLabel = (window: string) => windowLabels[window] ?? window

const windowRank = (window: string) => {
  const rank = limitWindows.indexOf(window)
  return rank === -1 ? limitWindows.length : rank
}

/** A reading younger than this is fresh and says nothing of its age. */
const freshSeconds = 15 * 60
/** A reading older than this may no longer be right, and its age reads as a warning. */
const agedSeconds = 3600

const isStale = (reading: UsageReading) => reading.stale === true || reading.status === 'stale'
const bucketOf = (reading: UsageReading) => (reading.bucket === undefined || reading.bucket === null || reading.bucket === 'default' ? null : reading.bucket)

const signedOut = /sign.?in|log.?in|auth|credential|expired|\b40[13]\b/i
const rateLimited = /\b429\b|rate.?limit/i

function lapseOf(agent: string, reading: UsageReading, now: Date): UsageLapse {
  const why = reading.staleReason ?? reading.reason
  if (signedOut.test(why)) return { cause: 'Sign-in expired', action: `Run ${agent} to sign in` }
  const wait = reading.retryAt === null || reading.retryAt === undefined ? null : reading.retryAt - now.getTime() / 1000
  return { cause: rateLimited.test(why) ? 'Rate limited' : 'Unavailable', action: wait === null || wait <= 0 ? 'Retrying' : `Retrying in ${Math.ceil(wait / 60)}m` }
}

function meterOf(reading: UsageReading & { usedPercent: number }, now: Date): UsageMeter {
  const resetsAt = parseResetsAt(reading.resetsAt)
  return {
    window: reading.window,
    label: windowLabel(reading.window),
    usedPercent: reading.usedPercent,
    tone: isStale(reading) ? 'stale' : usageLimitTone(reading.usedPercent),
    resetsAt,
    reset: resetsAt === null ? null : resetPhrase(resetsAt, now),
  }
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const clock = (at: Date) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
const dayMilliseconds = 24 * 3600 * 1000

/**
 * A reset in plain words: how far it is within a day, "Resets in 3h 43m"; the weekday and time within
 * the week, "Resets Tue 14:00"; the date beyond that, where a weekday alone could read as today.
 */
export function resetPhrase(at: Date, now: Date = new Date()): string {
  const ahead = at.getTime() - now.getTime()
  if (ahead <= 0) return 'Resets now'
  if (ahead < dayMilliseconds) return `Resets ${resetDistance(at, now)}`
  if (ahead < 6 * dayMilliseconds) return `Resets ${weekdays[at.getDay()] ?? ''} ${clock(at)}`
  return `Resets ${months[at.getMonth()] ?? ''} ${at.getDate()}, ${clock(at)}`
}

// 5-hour, weekly, then any other window in reading order, which a stable sort keeps.
export const byWindow = (a: UsageMeter, b: UsageMeter) => windowRank(a.window) - windowRank(b.window)

/** Each agent with a share, in the order the readings first name it. */
export function agentUsage(readings: UsageReading[], now: Date = new Date()): AgentUsage[] {
  const agents = [...new Set(readings.map((reading) => reading.provider))]
  return agents.flatMap((agent) => {
    const own = readings.filter((reading): reading is UsageReading & { usedPercent: number } => reading.provider === agent && reading.usedPercent !== null)
    if (own.length === 0) return []
    const buckets = [...new Set(own.map(bucketOf))]
    const pools = buckets.map((bucket) => ({
      bucket: buckets.length > 1 ? bucket : null,
      meters: own
        .filter((reading) => buckets.length === 1 || bucketOf(reading) === bucket)
        .map((reading) => meterOf(reading, now))
        .sort(byWindow),
    }))
    const lead = pools.flatMap((pool) => pool.meters).reduce((highest, meter) => (meter.usedPercent > highest.usedPercent ? meter : highest))
    const lapsed = own.find(isStale)
    const newest = Math.max(...own.map((reading) => reading.fetchedAt ?? -Infinity))
    const elapsed = now.getTime() / 1000 - newest
    const age = lapsed !== undefined || !Number.isFinite(newest) || elapsed < freshSeconds ? null : readingAge(newest, now)
    return [{ agent, color: agentColor(agent), pools, lead, age, aged: age !== null && elapsed > agedSeconds, lapse: lapsed === undefined ? null : lapseOf(agent, lapsed, now) }]
  })
}

const percentClasses: Record<MeterTone, string> = { normal: 'text-ink-300', amber: 'text-warn', red: 'text-bad-soft', stale: 'text-ink-400' }

/** A share's text colour: neutral, then warning and a light critical rose near the limit, dimmed but legible when stale. */
export const percentClass = (tone: MeterTone) => percentClasses[tone]

const fillClasses: Record<MeterTone, string> = { normal: 'bg-accent', amber: 'bg-warn', red: 'bg-bad', stale: 'bg-ink-500' }

/** A meter's fill: the accent, then the theme's warning and critical tones near the limit, grey when stale. */
export const fillClass = (tone: MeterTone) => fillClasses[tone]
