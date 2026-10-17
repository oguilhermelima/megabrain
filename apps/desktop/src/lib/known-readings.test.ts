import { describe, expect, test } from 'bun:test'
import type { Settings, UsageReading } from '@/api/schema'
import { keepKnownReadings } from '@/lib/known-readings'

const reading = (provider: string, window: string, usedPercent: number | null, status = usedPercent === null ? 'unknown' : 'current', bucket: string | null = null): UsageReading => ({
  provider,
  window,
  status,
  usedPercent,
  resetsAt: usedPercent === null ? null : '2099-01-01T00:00:00Z',
  fetchedAt: usedPercent === null ? null : 1000,
  reason: `${provider} ${window}`,
  bucket,
})

const settings = (...readings: UsageReading[]): Settings => ({ limits: { enabledProviders: [], notice: { enabled: false, intervalSeconds: 3600 }, readings } }) as unknown as Settings

describe('keepKnownReadings', () => {
  test('a reading that arrives blank does not replace one that had a value', () => {
    const next = keepKnownReadings(settings(reading('claude', '5h', 5), reading('codex', '5h', 17)), settings(reading('claude', '5h', null), reading('codex', '5h', 18)))
    expect(next.limits.readings).toEqual([expect.objectContaining({ provider: 'claude', usedPercent: 5, status: 'stale', fetchedAt: 1000 }), expect.objectContaining({ provider: 'codex', usedPercent: 18 })])
  })

  test('a provider missing from the new read keeps its readings', () => {
    const next = keepKnownReadings(settings(reading('claude', '5h', 5), reading('claude', 'weekly', 24)), settings(reading('codex', '5h', 17)))
    expect(next.limits.readings.map((item) => [item.provider, item.window, item.usedPercent, item.status])).toEqual([
      ['codex', '5h', 17, 'current'],
      ['claude', '5h', 5, 'stale'],
      ['claude', 'weekly', 24, 'stale'],
    ])
  })

  test('keeps same-window buckets independently', () => {
    const next = keepKnownReadings(
      settings(reading('agy', 'weekly', 15, 'current', 'Gemini Models'), reading('agy', 'weekly', 47, 'current', 'Claude and GPT models')),
      settings(reading('agy', 'weekly', null, 'unknown', 'Claude and GPT models')),
    )
    expect(next.limits.readings.map((item) => [item.bucket, item.usedPercent, item.status])).toEqual([
      ['Claude and GPT models', 47, 'stale'], ['Gemini Models', 15, 'stale'],
    ])
  })

  test('each bucket of a window is its own reading', () => {
    const gemini = { ...reading('agy', '5h', 7), bucket: 'Gemini Models' }
    const others = { ...reading('agy', '5h', 40), bucket: 'Claude and GPT models' }
    const next = keepKnownReadings(settings(gemini, others), settings({ ...gemini, usedPercent: null, status: 'unknown' }, { ...others, usedPercent: 41 }))
    expect(next.limits.readings.map((item) => [item.bucket, item.usedPercent, item.status])).toEqual([
      ['Gemini Models', 7, 'stale'],
      ['Claude and GPT models', 41, 'current'],
    ])
  })

  test('a new value always replaces the old one, and nothing before it means nothing to keep', () => {
    const fresh = settings(reading('claude', '5h', 9))
    expect(keepKnownReadings(settings(reading('claude', '5h', 5)), fresh).limits.readings).toEqual(fresh.limits.readings)
    expect(keepKnownReadings(null, fresh)).toBe(fresh)
    const blank = settings(reading('claude', '5h', null))
    expect(keepKnownReadings(null, blank)).toBe(blank)
  })
})
