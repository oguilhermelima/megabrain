import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mockSettings } from '@/api/fixtures/mock'
import { usageReadingSchema, type UsageReading } from '@/api/schema'
import { agentColor } from '@/components/agent-activity'
import { agentUsage, closestToLimit, fillClass, percentClass, resetPhrase, type AgentUsage } from '@/advanced/usage-limits'
import { UsageFooterItem } from '@/advanced/UsageMeters'

const now = new Date(1_800_000_000 * 1000)
const seconds = now.getTime() / 1000

const reading = (provider: string, window: string, usedPercent: number | null, extra: Partial<UsageReading> = {}): UsageReading => ({
  provider,
  window,
  status: usedPercent === null ? 'unknown' : 'current',
  usedPercent,
  resetsAt: null,
  fetchedAt: seconds - 30,
  reason: `${provider} ${window} window`,
  ...extra,
})

const shape = (usage: AgentUsage[]) => usage.map((item) => [item.agent, item.pools.map((pool) => [pool.bucket, pool.meters.map((meter) => [meter.window, meter.usedPercent])])])

describe('agentUsage grouping', () => {
  test('one entry per provider in reading order, a single pool without a label when the provider has one bucket', () => {
    const usage = agentUsage([reading('codex', '5h', 30), reading('claude', '5h', 5), reading('codex', 'weekly', 58), reading('claude', 'weekly', 42, { bucket: 'default' })], now)
    expect(shape(usage)).toEqual([
      ['codex', [[null, [['5h', 30], ['weekly', 58]]]]],
      ['claude', [[null, [['5h', 5], ['weekly', 42]]]]],
    ])
  })

  test('a provider with several buckets has a labelled pool per bucket, in the order the readings name them', () => {
    const usage = agentUsage(
      [
        reading('agy', 'weekly', 3, { bucket: 'Gemini Models' }),
        reading('agy', '5h', 7, { bucket: 'Gemini Models' }),
        reading('agy', 'weekly', 12, { bucket: 'Claude and GPT models' }),
        reading('agy', '5h', 40, { bucket: 'Claude and GPT models' }),
      ],
      now,
    )
    expect(shape(usage)).toEqual([
      [
        'agy',
        [
          ['Gemini Models', [['5h', 7], ['weekly', 3]]],
          ['Claude and GPT models', [['5h', 40], ['weekly', 12]]],
        ],
      ],
    ])
  })

  test('one named bucket is still a single pool without a label', () => {
    expect(shape(agentUsage([reading('agy', '5h', 7, { bucket: 'Gemini Models' }), reading('agy', 'weekly', 3, { bucket: 'Gemini Models' })], now))).toEqual([['agy', [[null, [['5h', 7], ['weekly', 3]]]]]])
  })

  test('a window without a share is left out, then a pool, then a provider with none', () => {
    const usage = agentUsage(
      [reading('grok', '5h', null), reading('grok', 'weekly', null), reading('agy', '5h', 9, { bucket: 'Gemini Models' }), reading('agy', '5h', null, { bucket: 'Claude and GPT models' }), reading('claude', '5h', 4), reading('claude', 'weekly', null)],
      now,
    )
    expect(shape(usage)).toEqual([
      ['agy', [[null, [['5h', 9]]]]],
      ['claude', [[null, [['5h', 4]]]]],
    ])
    expect(agentUsage([], now)).toEqual([])
  })
})

describe('agentUsage order and lead', () => {
  test('every pool reads 5-hour, weekly, then any other window in reading order, however full each is', () => {
    const windows = (readings: UsageReading[]) => agentUsage(readings, now)[0]?.pools.map((pool) => pool.meters.map((meter) => meter.window))
    expect(windows([reading('codex', 'weekly', 90), reading('codex', '5h', 10)])).toEqual([['5h', 'weekly']])
    expect(windows([reading('claude', 'opus-weekly', 93), reading('claude', 'weekly', 30), reading('claude', 'sonnet-weekly', 50), reading('claude', '5h', 10)])).toEqual([['5h', 'weekly', 'opus-weekly', 'sonnet-weekly']])
    expect(windows([reading('agy', 'weekly', 3, { bucket: 'A' }), reading('agy', '5h', 7, { bucket: 'A' }), reading('agy', '5h', 40, { bucket: 'B' }), reading('agy', 'weekly', 12, { bucket: 'B' })])).toEqual([
      ['5h', 'weekly'],
      ['5h', 'weekly'],
    ])
  })

  test('the lead is the most constraining window across every pool', () => {
    const [agy] = agentUsage([reading('agy', '5h', 7, { bucket: 'Gemini Models' }), reading('agy', 'weekly', 64, { bucket: 'Claude and GPT models' }), reading('agy', '5h', 12, { bucket: 'Claude and GPT models' })], now)
    expect(agy?.lead).toMatchObject({ window: 'weekly', usedPercent: 64 })
  })

  test('each meter names its window and when it resets in plain words', () => {
    const [claude] = agentUsage([reading('claude', '5h', 5, { resetsAt: String(seconds + 3 * 3600 + 43 * 60) }), reading('claude', 'weekly', 42, { resetsAt: null })], now)
    expect(claude?.pools[0]?.meters.map((meter) => [meter.label, meter.reset])).toEqual([
      ['5-hour', 'Resets in 3h 43m'],
      ['Weekly', null],
    ])
  })

  test('the agent carries its own colour', () => {
    expect(agentUsage([reading('claude', '5h', 5)], now)[0]?.color).toBe(agentColor('claude'))
  })
})

describe('agentUsage tone', () => {
  const tone = (usedPercent: number) => agentUsage([reading('codex', '5h', usedPercent)], now)[0]?.lead.tone
  test('neutral up to 70 percent, warning above it, critical above 90', () => {
    expect([0, 70, 70.5, 90, 90.5, 100].map(tone)).toEqual(['normal', 'normal', 'amber', 'amber', 'red', 'red'])
  })

  test('the percent colour stays neutral, warns and turns a light rose when critical; a stale one is dimmed but legible', () => {
    expect(percentClass('normal')).toBe('text-ink-300')
    expect(percentClass('amber')).toBe('text-warn')
    expect(percentClass('red')).toBe('text-bad-soft')
    expect(percentClass('stale')).toBe('text-ink-400')
  })
})

describe('resetPhrase', () => {
  // Local time, as the phrase reads it: Tuesday 6 October 2026, 09:00.
  const tuesday = new Date(2026, 9, 6, 9, 0)
  const later = (minutes: number) => new Date(tuesday.getTime() + minutes * 60_000)

  test('a reset already due is now', () => {
    expect(resetPhrase(tuesday, tuesday)).toBe('Resets now')
    expect(resetPhrase(later(-5), tuesday)).toBe('Resets now')
  })

  test('within a day it says how far, in minutes, then hours and minutes', () => {
    expect(resetPhrase(later(42), tuesday)).toBe('Resets in 42m')
    expect(resetPhrase(later(3 * 60 + 43), tuesday)).toBe('Resets in 3h 43m')
    expect(resetPhrase(later(24 * 60 - 1), tuesday)).toBe('Resets in 23h 59m')
  })

  test('from a day out it names the weekday and a 24-hour time', () => {
    expect(resetPhrase(new Date(2026, 9, 7, 9, 0), tuesday)).toBe('Resets Wed 09:00')
    expect(resetPhrase(new Date(2026, 9, 9, 14, 5), tuesday)).toBe('Resets Fri 14:05')
  })

  test('six days or more out it names the date, since the weekday alone could read as this week', () => {
    expect(resetPhrase(new Date(2026, 9, 12, 9, 0), tuesday)).toBe('Resets Oct 12, 09:00')
    expect(resetPhrase(new Date(2026, 9, 13, 8, 30), tuesday)).toBe('Resets Oct 13, 08:30')
  })
})

describe('fillClass', () => {
  test('the accent when there is room, warning and critical near the limit, grey when stale', () => {
    expect(fillClass('normal')).toBe('bg-accent')
    expect(fillClass('amber')).toBe('bg-warn')
    expect(fillClass('red')).toBe('bg-bad')
    expect(fillClass('stale')).toBe('bg-ink-500')
  })
})

describe('closestToLimit', () => {
  test('the fullest window across every agent and pool, with the pool it counts', () => {
    const usage = agentUsage(
      [reading('claude', '5h', 20), reading('claude', 'weekly', 61), reading('agy', '5h', 7, { bucket: 'Gemini Models' }), reading('agy', 'weekly', 84, { bucket: 'Claude and GPT models' }), reading('codex', 'weekly', 40)],
      now,
    )
    expect(closestToLimit(usage)).toMatchObject({ agent: 'agy', bucket: 'Claude and GPT models', meter: { window: 'weekly', usedPercent: 84, tone: 'amber' } })
  })

  test('a single pool has no bucket, and a tie goes to the first agent and window', () => {
    expect(closestToLimit(agentUsage([reading('codex', '5h', 50), reading('claude', 'weekly', 50), reading('claude', '5h', 50)], now))).toMatchObject({ agent: 'codex', bucket: null, meter: { window: '5h' } })
  })

  test('a last-known window never counts, however full; nothing when none is current', () => {
    const stale = { status: 'stale', reason: 'x (sign-in expired)' } as const
    expect(closestToLimit(agentUsage([reading('grok', 'weekly', 99, stale), reading('codex', '5h', 12)], now))).toMatchObject({ agent: 'codex', meter: { usedPercent: 12 } })
    expect(closestToLimit(agentUsage([reading('grok', 'weekly', 99, stale)], now))).toBeNull()
    expect(closestToLimit([])).toBeNull()
  })
})

describe('agentUsage staleness', () => {
  test('a stale reading is muted however high it is, never a warning', () => {
    const [grok] = agentUsage([reading('grok', 'weekly', 95, { status: 'stale', reason: 'grok weekly window is stale (sign-in expired)' })], now)
    expect(grok?.lead.tone).toBe('stale')
    expect(grok?.lapse).toEqual({ cause: 'Sign-in expired', action: 'Run grok to sign in' })
  })

  test('the stale flag and its reason count as much as the status', () => {
    const [grok] = agentUsage([reading('grok', 'weekly', 81, { stale: true, staleReason: 'auth token expired (401)', reason: 'grok weekly window at 81 percent' })], now)
    expect(grok?.lead.tone).toBe('stale')
    expect(grok?.lapse).toEqual({ cause: 'Sign-in expired', action: 'Run grok to sign in' })
  })

  test('a rate limit says when it retries; any other failure just that it retries', () => {
    const limited = agentUsage([reading('claude', '5h', 5, { status: 'stale', reason: 'claude 5h window is stale (provider returned HTTP 429)', retryAt: seconds + 240 })], now)[0]
    expect(limited?.lapse).toEqual({ cause: 'Rate limited', action: 'Retrying in 4m' })
    const failed = agentUsage([reading('agy', '5h', 5, { status: 'stale', reason: 'agy 5h window is stale (request timed out)', retryAt: seconds - 10 })], now)[0]
    expect(failed?.lapse).toEqual({ cause: 'Unavailable', action: 'Retrying' })
  })

  test('only the stale windows are muted; a current provider has no lapse', () => {
    const [claude] = agentUsage([reading('claude', '5h', 92), reading('claude', 'weekly', 50, { status: 'stale', reason: 'x (HTTP 429)' })], now)
    expect(claude?.pools[0]?.meters.map((meter) => meter.tone)).toEqual(['red', 'stale'])
    expect(agentUsage([reading('codex', '5h', 92)], now)[0]?.lapse).toBeNull()
  })
})

describe('agentUsage freshness', () => {
  test('a fresh reading says nothing; an older one says how old it is', () => {
    const age = (fetchedAt: number | null) => agentUsage([reading('codex', '5h', 10, { fetchedAt })], now)[0]?.age
    expect(age(seconds - 30)).toBeNull()
    expect(age(seconds - 14 * 60)).toBeNull()
    expect(age(seconds - 2 * 3600)).toBe('2h ago')
    expect(age(null)).toBeNull()
  })

  test('the newest reading of the provider dates it', () => {
    expect(agentUsage([reading('codex', '5h', 10, { fetchedAt: seconds - 7200 }), reading('codex', 'weekly', 10, { fetchedAt: seconds - 60 })], now)[0]?.age).toBeNull()
  })

  test('a stale provider says why rather than how old', () => {
    expect(agentUsage([reading('grok', 'weekly', 81, { status: 'stale', fetchedAt: seconds - 2 * 86_400, reason: 'x (sign-in expired)' })], now)[0]?.age).toBeNull()
  })
})

describe('UsageFooterItem', () => {
  const render = (readings: UsageReading[]) => {
    const [usage] = agentUsage(readings, now)
    if (usage === undefined) throw new Error('no usage')
    return renderToStaticMarkup(createElement(UsageFooterItem, { usage }))
  }

  test('only the mark in the agent colour and the percent, no ring', () => {
    const markup = render([reading('claude', '5h', 5), reading('claude', 'weekly', 42)])
    expect(markup.match(/<svg/g)?.length).toBe(1)
    expect(markup).toContain(`color:${agentColor('claude')}`)
    expect(markup.replace(/<title>[^<]*<\/title>/g, '').replace(/<[^>]+>/g, '')).toBe('42%')
    expect(markup).toContain(percentClass('normal'))
  })

  test('the percent warns near the limit and is muted when stale', () => {
    expect(render([reading('codex', 'weekly', 81)])).toContain(percentClass('amber'))
    expect(render([reading('codex', 'weekly', 95)])).toContain(percentClass('red'))
    const stale = render([reading('grok', 'weekly', 95, { status: 'stale', reason: 'x (sign-in expired)' })])
    expect(stale).toContain(percentClass('stale'))
    expect(stale).not.toContain(percentClass('red'))
  })
})

describe('agentColor', () => {
  test('each agent its own colour, Codex and Grok the near-white ink, an unknown one the accent', () => {
    expect(['claude', 'codex', 'agy', 'grok'].map(agentColor)).toEqual(['#D97757', 'var(--color-ink-100)', '#4C8DF6', 'var(--color-ink-100)'])
    expect(agentColor('other')).toBe('var(--color-accent)')
  })
})

describe('usage readings schema and mock', () => {
  test('the optional bucket, source and stale fields are typed', () => {
    const row = { ...reading('agy', '5h', 7), bucket: 'Gemini Models', source: 'live', stale: false, staleReason: 'sign-in expired' }
    expect(usageReadingSchema.parse(row)).toMatchObject({ bucket: 'Gemini Models', source: 'live', stale: false, staleReason: 'sign-in expired' })
    expect(usageReadingSchema.safeParse({ ...row, stale: 'yes' }).success).toBe(false)
    expect(usageReadingSchema.safeParse({ ...row, bucket: 4 }).success).toBe(false)
  })

  test('a reading the CLI could not take has a null bucket, and still parses', () => {
    const row = { ...reading('grok', 'weekly', null), bucket: null, source: 'unknown', reason: 'grok weekly window unknown (Grok sign-in expired; run grok once to refresh it)' }
    expect(usageReadingSchema.safeParse(row).success).toBe(true)
    expect(agentUsage([row, reading('grok', '5h', 12, { bucket: null })], now)[0]?.pools.map((pool) => pool.bucket)).toEqual([null])
  })

  test('the mock shows agy with two pools and a stale grok', () => {
    const usage = agentUsage(mockSettings.limits.readings)
    const agy = usage.find((item) => item.agent === 'agy')
    expect(agy?.pools.map((pool) => pool.bucket)).toEqual(['Gemini Models', 'Claude and GPT models'])
    const grok = usage.find((item) => item.agent === 'grok')
    expect(grok?.lead).toMatchObject({ usedPercent: 81, tone: 'stale' })
    expect(grok?.lapse).toEqual({ cause: 'Sign-in expired', action: 'Run grok to sign in' })
  })
})
