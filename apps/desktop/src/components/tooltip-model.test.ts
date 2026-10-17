import { describe, expect, test } from 'bun:test'
import { placeTip } from '@/components/tooltip-model'

const viewport = { width: 1000, height: 800 }
const size = { width: 200, height: 40 }

describe('placeTip', () => {
  test('sits centred above its anchor', () => {
    expect(placeTip({ left: 400, top: 700, right: 500, bottom: 728 }, size, viewport)).toEqual({ left: 350, top: 654 })
  })

  test('goes below an anchor with no room above', () => {
    expect(placeTip({ left: 400, top: 20, right: 500, bottom: 48 }, size, viewport)).toEqual({ left: 350, top: 54 })
  })

  test('stays inside the window at either side', () => {
    expect(placeTip({ left: 0, top: 700, right: 40, bottom: 728 }, size, viewport).left).toBe(8)
    expect(placeTip({ left: 960, top: 700, right: 1000, bottom: 728 }, size, viewport).left).toBe(792)
  })

  test('never leaves the window, even wider than it', () => {
    const placed = placeTip({ left: 0, top: 0, right: 10, bottom: 790 }, { width: 2000, height: 40 }, viewport)
    expect(placed.left).toBe(8)
    expect(placed.top).toBeGreaterThanOrEqual(8)
    expect(placed.top + 40).toBeLessThanOrEqual(792)
  })
})
