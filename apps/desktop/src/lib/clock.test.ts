import { describe, expect, test } from 'bun:test'
import { clockInterval } from '@/lib/clock'

describe('clockInterval', () => {
  test('a display clock ticks while the window shows and stops while it is hidden', () => {
    expect(clockInterval(true, 1_000)).toBe(1_000)
    expect(clockInterval(true, 30_000)).toBe(30_000)
    expect(clockInterval(false, 1_000)).toBeNull()
  })
})
