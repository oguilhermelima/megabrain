import { describe, expect, test } from 'bun:test'
import { cubicBezier, readMotion } from '@/panes/scroll-motion'

describe('scroll motion from the motion tokens', () => {
  test('a cubic bezier starts at 0, ends at 1 and never goes back', () => {
    const ease = cubicBezier(0.32, 0.72, 0, 1)
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    let previous = 0
    for (let step = 1; step <= 20; step++) {
      const value = ease(step / 20)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
  })

  test('the linear curve is the identity', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    expect(linear(0.25)).toBeCloseTo(0.25, 4)
    expect(linear(0.7)).toBeCloseTo(0.7, 4)
  })

  test('the panel token reads as its duration and curve', () => {
    const motion = readMotion('240ms', 'cubic-bezier(0.32, 0.72, 0, 1)')
    expect(motion.ms).toBe(240)
    expect(motion.ease(0.5)).toBeCloseTo(cubicBezier(0.32, 0.72, 0, 1)(0.5), 6)
  })

  test('seconds read as milliseconds; reduced motion or garbage is no motion', () => {
    expect(readMotion('0.3s', 'ease').ms).toBe(300)
    expect(readMotion('0ms', 'cubic-bezier(0.32, 0.72, 0, 1)').ms).toBe(0)
    expect(readMotion('', '').ms).toBe(0)
    expect(readMotion('240ms', 'nonsense').ease(0.5)).toBeCloseTo(0.5, 6)
  })
})
