import { describe, expect, test } from 'bun:test'
import type { UsageReading } from '@/api/schema'
import { collapseAll, collapsedByDefault, isPoolCollapsed, isProviderCollapsed, mostUsed, parseUsageCollapse, poolKey, readUsageCollapse, serialiseUsageCollapse, usageCollapseKey, writeUsageCollapse } from '@/advanced/usage-collapse'
import { agentUsage } from '@/advanced/usage-limits'

const now = new Date(1_800_000_000 * 1000)

const reading = (provider: string, window: string, usedPercent: number, bucket?: string): UsageReading => ({
  provider,
  window,
  status: 'current',
  usedPercent,
  resetsAt: null,
  fetchedAt: now.getTime() / 1000 - 30,
  reason: `${provider} ${window} window`,
  ...(bucket === undefined ? {} : { bucket }),
})

const agy = agentUsage(
  [
    reading('agy', '5h', 7, 'Gemini Models'),
    reading('agy', 'weekly', 3, 'Gemini Models'),
    reading('agy', '5h', 40, 'Claude and GPT models'),
    reading('agy', 'weekly', 64, 'Claude and GPT models'),
    reading('agy', 'weekly', 12, 'Gemini 4 Argon'),
  ],
  now,
)[0]
const codex = agentUsage([reading('codex', '5h', 30), reading('codex', 'weekly', 58)], now)[0]

describe('the window a folded row shows', () => {
  test('is the most used of the pool, the first on a tie, and none for an empty pool', () => {
    const pools = agy?.pools ?? []
    expect(mostUsed(pools[0]?.meters ?? [])).toMatchObject({ window: '5h', usedPercent: 7 })
    expect(mostUsed(pools[1]?.meters ?? [])).toMatchObject({ window: 'weekly', usedPercent: 64 })
    const tied = agentUsage([reading('claude', '5h', 50), reading('claude', 'weekly', 50)], now)[0]
    expect(mostUsed(tied?.pools[0]?.meters ?? [])).toMatchObject({ window: '5h' })
    expect(mostUsed([])).toBeNull()
  })

  test('for a provider is the most used of all its pools, the one its foot item shows', () => {
    const all = (agy?.pools ?? []).flatMap((pool) => pool.meters)
    expect(mostUsed(all)).toMatchObject({ window: 'weekly', usedPercent: 64 })
    expect(agy?.lead).toBe(mostUsed(all) ?? undefined)
  })
})

describe('the default fold', () => {
  test('folds more than two windows only', () => {
    expect([1, 2, 3, 5].map(collapsedByDefault)).toEqual([false, false, true, true])
  })

  test('a provider with five windows starts folded, one with two starts open, and a choice overrides either', () => {
    if (agy === undefined || codex === undefined) throw new Error('fixture')
    expect(isProviderCollapsed({}, agy)).toBe(true)
    expect(isProviderCollapsed({}, codex)).toBe(false)
    expect(isProviderCollapsed({ agy: false, codex: true }, agy)).toBe(false)
    expect(isProviderCollapsed({ agy: false, codex: true }, codex)).toBe(true)
  })

  test('a named pool of two windows starts open and follows its own key; an unnamed pool never folds', () => {
    if (agy === undefined || codex === undefined) throw new Error('fixture')
    const [gemini] = agy.pools
    if (gemini === undefined) throw new Error('fixture')
    expect(isPoolCollapsed({}, 'agy', gemini)).toBe(false)
    expect(isPoolCollapsed({ [poolKey('agy', 'Gemini Models')]: true }, 'agy', gemini)).toBe(true)
    expect(isPoolCollapsed({ [poolKey('other', 'Gemini Models')]: true }, 'agy', gemini)).toBe(false)
    const [only] = codex.pools
    if (only === undefined) throw new Error('fixture')
    expect(isPoolCollapsed({ [poolKey('codex', 'default')]: true }, 'codex', only)).toBe(false)
  })
})

describe('compact and expand all', () => {
  test('compact folds every provider and keeps each pool as it was; expand all opens providers and pools', () => {
    if (agy === undefined || codex === undefined) throw new Error('fixture')
    const start = { [poolKey('agy', 'Gemini Models')]: true }
    expect(collapseAll(start, [agy, codex], true)).toEqual({ ...start, agy: true, codex: true })
    expect(collapseAll(start, [agy, codex], false)).toEqual({
      agy: false,
      codex: false,
      [poolKey('agy', 'Gemini Models')]: false,
      [poolKey('agy', 'Claude and GPT models')]: false,
      [poolKey('agy', 'Gemini 4 Argon')]: false,
    })
  })
})

describe('the stored fold', () => {
  const memory = () => {
    const items = new Map<string, string>()
    return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
  }

  test('a write reads back the same choices under its own key', () => {
    const storage = memory()
    writeUsageCollapse(storage, { agy: false, [poolKey('agy', 'Gemini 4 Argon')]: true })
    expect([...storage.items.keys()]).toEqual([usageCollapseKey])
    expect(readUsageCollapse(storage)).toEqual({ agy: false, [poolKey('agy', 'Gemini 4 Argon')]: true })
  })

  test('nothing stored, a broken value, another version or a non-boolean choice reads as nothing chosen', () => {
    expect(parseUsageCollapse(null)).toEqual({})
    expect(parseUsageCollapse('{not json')).toEqual({})
    expect(parseUsageCollapse('[]')).toEqual({})
    expect(parseUsageCollapse(JSON.stringify({ version: 2, collapsed: { agy: true } }))).toEqual({})
    expect(parseUsageCollapse(JSON.stringify({ version: 1, collapsed: { agy: true, codex: 'yes', grok: null } }))).toEqual({ agy: true })
    expect(parseUsageCollapse(serialiseUsageCollapse({ codex: false }))).toEqual({ codex: false })
  })

  test('storage that throws reads as nothing chosen and a write is dropped without throwing', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readUsageCollapse(broken)).toEqual({})
    expect(() => writeUsageCollapse(broken, { agy: true })).not.toThrow()
  })
})
