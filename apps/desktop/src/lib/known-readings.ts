import type { Settings, UsageReading } from '@/api/schema'

/**
 * The settings a refresh brings, with every usage reading the last read knew and this one lost kept:
 * a window that arrives without a share, or a provider that is missing, shows its old value as stale
 * until a new one arrives. A reading is only ever replaced by another that has a value.
 */
export function keepKnownReadings(previous: Settings | null, next: Settings): Settings {
  if (previous === null) return next
  const key = (reading: UsageReading) => `${reading.provider}:${reading.window}`
  const known = new Map(previous.limits.readings.filter((reading) => reading.usedPercent !== null).map((reading) => [key(reading), reading]))
  const asStale = (reading: UsageReading): UsageReading => (reading.status === 'current' ? { ...reading, status: 'stale' } : reading)
  const readings = next.limits.readings.map((reading) => {
    const before = known.get(key(reading))
    return reading.usedPercent === null && before !== undefined ? asStale(before) : reading
  })
  const present = new Set(readings.map(key))
  const missing = [...known.values()].filter((reading) => !present.has(key(reading))).map(asStale)
  if (missing.length === 0 && readings.every((reading, index) => reading === next.limits.readings[index])) return next
  return { ...next, limits: { ...next.limits, readings: [...readings, ...missing] } }
}
