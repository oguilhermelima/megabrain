import { describe, expect, test } from 'bun:test'
import type { UsageReading, UsageStats } from '@/api/schema'
import { formatCost, formatDay, formatDuration, formatMonthDay, formatTokens, heatmap, providerCards, rangeDays, tokenMix } from '@/settings/usage-model'
import { groupReadingsByProvider } from '@/settings/settings-model'

const provider = (name: string, total: number, tracked = true): UsageStats['providers'][number] => ({
  provider: name,
  tracked,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total,
  sessions: 1,
  turns: 2,
  cost: null,
  unpricedTokens: total,
  share: 0,
  lastModel: null,
  lastProject: null,
  lastActiveAt: null,
})

const reading = (name: string, window: string, usedPercent: number | null): UsageReading => ({ provider: name, window, status: 'ok', usedPercent, resetsAt: null, fetchedAt: null, reason: '' })

describe('the range', () => {
  test('7, 30 and 90 days, or everything', () => {
    expect(rangeDays).toEqual({ '7': 7, '30': 30, '90': 90, all: null })
  })
})

describe('heatmap', () => {
  test('whole weeks from Sunday, ending in the week of today, with days after today left out', () => {
    // 2026-10-16 is a Friday.
    const map = heatmap([], '2026-10-16', 2)
    expect(map.weeks).toHaveLength(2)
    expect(map.weeks[0]?.[0]?.date).toBe('2026-10-04')
    expect(map.weeks[1]?.map((cell) => cell?.date ?? null)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', null])
  })

  test('a day with no tokens is level 0; the rest are split in quartiles, so one busy day does not wash the others out', () => {
    const daily = [
      { date: '2026-10-11', total: 10, byProvider: {} },
      { date: '2026-10-12', total: 20, byProvider: {} },
      { date: '2026-10-13', total: 30, byProvider: {} },
      { date: '2026-10-14', total: 1_000_000, byProvider: {} },
    ]
    const map = heatmap(daily, '2026-10-16', 1)
    expect(map.weeks[0]?.map((cell) => cell?.level ?? null)).toEqual([1, 2, 3, 4, 0, 0, null])
    expect(map.best).toEqual({ date: '2026-10-14', total: 1_000_000 })
  })

  test('days outside the weeks shown do not count', () => {
    const map = heatmap([{ date: '2026-01-01', total: 5, byProvider: {} }], '2026-10-16', 1)
    expect(map.best).toBeNull()
    expect(map.weeks[0]?.every((cell) => cell === null || cell.level === 0)).toBe(true)
  })
})

describe('tokenMix', () => {
  test('the five kinds in a fixed order with their share; empty kinds are dropped', () => {
    const mix = tokenMix({ input: 10, output: 30, cacheRead: 50, cacheWrite: 0, reasoning: 10 })
    expect(mix.map((segment) => [segment.key, segment.value])).toEqual([
      ['input', 10],
      ['output', 30],
      ['cacheRead', 50],
      ['reasoning', 10],
    ])
    expect(mix.map((segment) => segment.share)).toEqual([0.1, 0.3, 0.5, 0.1])
  })

  test('no tokens is no segments', () => {
    expect(tokenMix({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })).toEqual([])
  })
})

describe('formatting', () => {
  test('tokens are compact in the locale', () => {
    expect(formatTokens(11_700_000_000, 'en-US')).toBe('11.7B')
    expect(formatTokens(950, 'en-US')).toBe('950')
    expect(formatTokens(11_700_000_000, 'pt-BR')).toBe('11,7\u00a0bi')
  })

  test('cost in dollars, or a dash with no price', () => {
    expect(formatCost(1234.5, 'en-US')).toBe('$1,234.50')
    expect(formatCost(null, 'en-US')).toBe('—')
  })

  test('durations in the two largest units', () => {
    expect(formatDuration(151 * 86400 + 12 * 3600 + 59)).toBe('151d 12h')
    expect(formatDuration(5 * 3600 + 20 * 60)).toBe('5h 20m')
    expect(formatDuration(12 * 60)).toBe('12m')
    expect(formatDuration(0)).toBe('0m')
  })

  test('a day reads as that calendar day whatever the local zone', () => {
    expect(formatDay('2026-10-12', 'en-US')).toBe('Oct 12, 2026')
    expect(formatMonthDay('2026-10-12', 'en-US')).toBe('Oct 12')
  })
})

describe('providerCards', () => {
  test('every provider with usage, then those with only live readings, each with its readings and live state', () => {
    const cards = providerCards([provider('claude', 30), provider('codex', 0), provider('agy', 0, false)], groupReadingsByProvider([reading('codex', '5h', 40), reading('codex', 'weekly', 12), reading('gemini', '5h', 5)]), ['codex'])
    expect(cards.map((card) => [card.provider, card.usage?.total ?? null, card.fiveHour?.usedPercent ?? null, card.weekly?.usedPercent ?? null, card.liveEnabled])).toEqual([
      ['claude', 30, null, null, false],
      ['codex', 0, 40, 12, true],
      ['agy', 0, null, null, false],
      ['gemini', null, 5, null, false],
    ])
  })

  test('without stats the cards come from the readings alone', () => {
    const cards = providerCards(null, groupReadingsByProvider([reading('claude', '5h', 70)]), [])
    expect(cards).toEqual([{ provider: 'claude', usage: null, fiveHour: reading('claude', '5h', 70), weekly: null, liveEnabled: false }])
  })
})
