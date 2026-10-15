import { describe, expect, test } from 'bun:test'
import { placeMenu } from '@/advanced/menu-placement'

const viewport = { width: 1000, height: 700 }
const size = { width: 200, height: 160 }
const point = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y })

describe('placeMenu', () => {
  test('opens to the right of and below a point with room', () => {
    expect(placeMenu(point(100, 100), size, viewport)).toEqual({ left: 100, top: 100 })
  })

  test('opens below a button, aligned to its left edge, with a gap', () => {
    expect(placeMenu({ left: 100, top: 100, right: 124, bottom: 124 }, size, viewport, 4)).toEqual({ left: 100, top: 128 })
  })

  test('flips left when it would leave the right edge', () => {
    expect(placeMenu(point(900, 100), size, viewport)).toEqual({ left: 700, top: 100 })
  })

  test('a button near the right edge aligns the menu to the button right edge', () => {
    expect(placeMenu({ left: 880, top: 100, right: 904, bottom: 124 }, size, viewport, 4)).toEqual({ left: 704, top: 128 })
  })

  test('flips up when it would leave the bottom edge', () => {
    expect(placeMenu(point(100, 650), size, viewport)).toEqual({ left: 100, top: 490 })
  })

  test('a button near the bottom opens above it with the gap', () => {
    expect(placeMenu({ left: 100, top: 640, right: 124, bottom: 664 }, size, viewport, 4)).toEqual({ left: 100, top: 476 })
  })

  test('flips both ways in the bottom right corner', () => {
    expect(placeMenu(point(950, 680), size, viewport)).toEqual({ left: 750, top: 520 })
  })

  test('never leaves the window margin when neither side has room', () => {
    const tall = { width: 200, height: 690 }
    expect(placeMenu(point(100, 300), tall, viewport)).toEqual({ left: 100, top: 8 })
    const wide = { width: 990, height: 100 }
    expect(placeMenu(point(500, 100), wide, viewport)).toEqual({ left: 8, top: 100 })
  })

  test('keeps the margin from the window edges after flipping', () => {
    expect(placeMenu(point(150, 650), { width: 200, height: 160 }, { width: 340, height: 700 })).toEqual({ left: 8, top: 490 })
  })
})
