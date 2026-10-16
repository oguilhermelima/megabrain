import { describe, expect, test } from 'bun:test'
import { motionMs, presence } from '@/lib/motion'

describe('motionMs', () => {
  test('reads milliseconds and seconds', () => {
    expect(motionMs('160ms')).toBe(160)
    expect(motionMs(' 0.24s ')).toBe(240)
    expect(motionMs('.1s')).toBe(100)
  })

  test('reduced motion sets the tokens to zero', () => {
    expect(motionMs('0ms')).toBe(0)
    expect(motionMs('0s')).toBe(0)
  })

  test('a missing or unreadable token holds nothing', () => {
    expect(motionMs('')).toBe(0)
    expect(motionMs('fast')).toBe(0)
    expect(motionMs('160')).toBe(0)
    expect(motionMs('-5ms')).toBe(0)
  })
})

describe('presence', () => {
  const menu = { id: 'a' }

  test('an open value shows and is not leaving', () => {
    expect(presence(menu, null)).toEqual({ shown: menu, leaving: false })
    expect(presence(menu, menu)).toEqual({ shown: menu, leaving: false })
  })

  test('a closed value keeps the last one on screen while it leaves', () => {
    expect(presence(null, menu)).toEqual({ shown: menu, leaving: true })
  })

  test('once the exit is done nothing shows', () => {
    expect(presence(null, null)).toEqual({ shown: null, leaving: false })
  })

  test('a value that comes back while leaving shows again at once', () => {
    const next = { id: 'b' }
    expect(presence(next, menu)).toEqual({ shown: next, leaving: false })
  })

  test('a boolean flag works as a value', () => {
    expect(presence<true>(null, true)).toEqual({ shown: true, leaving: true })
  })
})
