import { describe, expect, test } from 'bun:test'
import type { UsageReading } from '@/api/schema'
import { providerUsage } from '@/chat/composer-status'
import { arrangeUsage, moveUsage, noUsageOrder, parseUsageOrder, serialiseUsageOrder, toggleUsageHidden, type UsageOrder } from '@/advanced/usage-order'

const reading = (provider: string, usedPercent: number, extra: Partial<UsageReading> = {}): UsageReading => ({
  provider,
  window: '5h',
  status: 'current',
  usedPercent,
  resetsAt: null,
  fetchedAt: 1_000,
  reason: `${provider} 5h window`,
  ...extra,
})

const usage = providerUsage([reading('codex', 37), reading('claude', 26), reading('agy', 0), reading('grok', 12)])
const agents = (items: { agent: string }[]) => items.map((item) => item.agent)
const order = (saved: string[], hidden: string[] = []): UsageOrder => ({ version: 1, order: saved, hidden })

describe('usage order persistence', () => {
  test('the order and the hidden set survive a round trip through the saved JSON', () => {
    const saved = order(['grok', 'claude', 'codex'], ['agy'])
    expect(parseUsageOrder(JSON.parse(serialiseUsageOrder(saved)))).toEqual(saved)
  })

  test('anything unusable reads as nothing saved, and non-strings are dropped', () => {
    for (const raw of [null, 'x', [], { version: 2, order: [], hidden: [] }, { version: 1, order: {}, hidden: [] }, { version: 1, order: [] }]) expect(parseUsageOrder(raw)).toEqual(noUsageOrder)
    expect(parseUsageOrder({ version: 1, order: ['codex', 4, 'claude'], hidden: [null, 'agy'] })).toEqual(order(['codex', 'claude'], ['agy']))
  })
})

describe('arrangeUsage', () => {
  test('with nothing saved, both follow the readings', () => {
    const { listed, strip } = arrangeUsage(usage, noUsageOrder)
    expect(agents(listed)).toEqual(['codex', 'claude', 'agy', 'grok'])
    expect(agents(strip)).toEqual(['codex', 'claude', 'agy', 'grok'])
  })

  test('the strip shows the providers in the saved order', () => {
    expect(agents(arrangeUsage(usage, order(['grok', 'agy', 'claude', 'codex'])).strip)).toEqual(['grok', 'agy', 'claude', 'codex'])
  })

  test('a provider the saved order does not name comes after, in reading order; a saved one without a reading is skipped', () => {
    expect(agents(arrangeUsage(usage, order(['gemini', 'claude', 'grok'])).strip)).toEqual(['claude', 'grok', 'codex', 'agy'])
  })

  test('a hidden provider leaves the strip and is listed last, in its own order', () => {
    const { listed, strip } = arrangeUsage(usage, order(['grok', 'agy', 'claude', 'codex'], ['grok', 'claude']))
    expect(agents(strip)).toEqual(['agy', 'codex'])
    expect(agents(listed)).toEqual(['agy', 'codex', 'grok', 'claude'])
  })
})

describe('moveUsage', () => {
  test('moves a provider within the shown ones, and the strip follows', () => {
    const saved = moveUsage(noUsageOrder, usage, 'grok', 0)
    expect(agents(arrangeUsage(usage, saved).strip)).toEqual(['grok', 'codex', 'claude', 'agy'])
  })

  test('stays inside its group: a shown provider never passes a hidden one, and the index is clamped', () => {
    const hidden = order([], ['codex'])
    const saved = moveUsage(hidden, usage, 'claude', 10)
    expect(agents(arrangeUsage(usage, saved).listed)).toEqual(['agy', 'grok', 'claude', 'codex'])
    expect(saved.hidden).toEqual(['codex'])
  })

  test('keeps the saved place of a provider with no reading now', () => {
    expect(moveUsage(order(['gemini', 'codex', 'claude']), usage, 'agy', 0).order).toEqual(['agy', 'codex', 'claude', 'grok', 'gemini'])
  })
})

describe('toggleUsageHidden', () => {
  test('hides, then shows again in the place it had', () => {
    const saved = order(['claude', 'codex', 'agy', 'grok'])
    const hidden = toggleUsageHidden(saved, 'codex')
    expect(agents(arrangeUsage(usage, hidden).strip)).toEqual(['claude', 'agy', 'grok'])
    expect(agents(arrangeUsage(usage, toggleUsageHidden(hidden, 'codex')).strip)).toEqual(['claude', 'codex', 'agy', 'grok'])
  })
})
