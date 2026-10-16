import { describe, expect, test } from 'bun:test'
import { initialLoad, settleLoad } from '@/lib/latest-load'

const good = ['a', 'b', 'c']

describe('settleLoad', () => {
  test('starts unloaded, with nothing and no error', () => {
    expect(initialLoad).toEqual({ value: null, error: null, failures: 0, settled: 0 })
  })

  test('a result loads the list and clears an earlier error', () => {
    const failed = settleLoad(initialLoad, { seq: 1, ok: false, error: 'busy' })
    expect(failed).toEqual({ value: null, error: 'busy', failures: 1, settled: 1 })
    expect(settleLoad(failed, { seq: 2, ok: true, value: good })).toEqual({ value: good, error: null, failures: 0, settled: 2 })
  })

  test('a failed refresh keeps the last good list', () => {
    const loaded = settleLoad(initialLoad, { seq: 1, ok: true, value: good })
    const failed = settleLoad(loaded, { seq: 2, ok: false, error: 'timeout' })
    expect(failed.value).toBe(good)
    expect(failed.failures).toBe(1)
    expect(settleLoad(failed, { seq: 3, ok: false, error: 'timeout' }).failures).toBe(2)
  })

  test('an older answer never overwrites a newer one', () => {
    const newer = settleLoad(initialLoad, { seq: 2, ok: true, value: good })
    expect(settleLoad(newer, { seq: 1, ok: true, value: [] })).toBe(newer)
    expect(settleLoad(newer, { seq: 1, ok: false, error: 'late' })).toBe(newer)
    expect(settleLoad(newer, { seq: 2, ok: true, value: [] })).toBe(newer)
  })
})
