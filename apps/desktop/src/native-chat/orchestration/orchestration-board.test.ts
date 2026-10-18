import { describe, expect, test } from 'bun:test'
import { BOARD_MARGIN, clampScale, fitView, keepInView, MAX_SCALE, MIN_SCALE, panBy, wheelZoom, zoomAt } from '@/native-chat/orchestration/orchestration-board'

describe('clampScale', () => {
  test('keeps a scale between the smallest and the largest', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(10)).toBe(MAX_SCALE)
    expect(clampScale(0.8)).toBe(0.8)
  })
})

describe('fitView', () => {
  test('a small tree draws at life size, centred', () => {
    expect(fitView({ width: 200, height: 100 }, { width: 1000, height: 600 })).toEqual({ x: 400, y: 250, scale: 1 })
  })
  test('a wide tree scales down to the width less the margins', () => {
    const view = fitView({ width: 1904, height: 300 }, { width: 1000, height: 600 })
    expect(view.scale).toBeCloseTo((1000 - BOARD_MARGIN * 2) / 1904)
    expect(view.x).toBeCloseTo(BOARD_MARGIN)
    expect(view.y).toBeCloseTo((600 - 300 * view.scale) / 2)
  })
  test('a tall tree scales down to the height', () => {
    const view = fitView({ width: 400, height: 1104 }, { width: 1000, height: 600 })
    expect(view.scale).toBeCloseTo((600 - BOARD_MARGIN * 2) / 1104)
    expect(view.y).toBeCloseTo(BOARD_MARGIN)
  })
  test('a tree too big for the smallest scale starts at its top', () => {
    const view = fitView({ width: 400, height: 100_000 }, { width: 1000, height: 600 })
    expect(view.scale).toBe(MIN_SCALE)
    expect(view.y).toBe(BOARD_MARGIN)
    expect(view.x).toBe((1000 - 400 * MIN_SCALE) / 2)
  })
  test('nothing measured yet draws at life size', () => {
    expect(fitView({ width: 0, height: 0 }, { width: 1000, height: 600 }).scale).toBe(1)
  })
})

describe('zoomAt', () => {
  test('the point under the pointer stays over the same spot of the canvas', () => {
    const view = { x: 30, y: -20, scale: 0.8 }
    const point = { x: 400, y: 250 }
    const canvasPoint = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
    const zoomed = zoomAt(view, 1.5, point)
    expect(zoomed.scale).toBeCloseTo(1.2)
    expect(zoomed.x + canvasPoint.x * zoomed.scale).toBeCloseTo(point.x)
    expect(zoomed.y + canvasPoint.y * zoomed.scale).toBeCloseTo(point.y)
  })
  test('stops at the largest scale and moves only as far as that scale', () => {
    const zoomed = zoomAt({ x: 0, y: 0, scale: 1.8 }, 4, { x: 100, y: 100 })
    expect(zoomed.scale).toBe(MAX_SCALE)
    expect(zoomed.x).toBeCloseTo(100 - 100 * (MAX_SCALE / 1.8))
  })
  test('at the smallest scale zooming out changes nothing', () => {
    expect(zoomAt({ x: 10, y: 20, scale: MIN_SCALE }, 0.5, { x: 300, y: 300 })).toEqual({ x: 10, y: 20, scale: MIN_SCALE })
  })
})

describe('panBy', () => {
  test('moves the canvas and keeps the scale', () => {
    expect(panBy({ x: 10, y: 10, scale: 0.5 }, -30, 40)).toEqual({ x: -20, y: 50, scale: 0.5 })
  })
})

describe('keepInView', () => {
  const viewport = { width: 800, height: 600 }
  test('a card already shown leaves the view as it is', () => {
    const view = { x: 0, y: 0, scale: 1 }
    expect(keepInView(view, { left: 100, top: 100, width: 248, height: 120 }, viewport)).toBe(view)
  })
  test('a card past the right edge comes in to the margin', () => {
    const view = keepInView({ x: 0, y: 0, scale: 1 }, { left: 700, top: 100, width: 248, height: 120 }, viewport)
    expect(view.x + (700 + 248)).toBe(800 - BOARD_MARGIN)
    expect(view.y).toBe(0)
  })
  test('a card above the top comes down to the margin, at scale', () => {
    const view = keepInView({ x: 0, y: -400, scale: 0.5 }, { left: 0, top: 200, width: 248, height: 120 }, viewport)
    expect(view.y + 200 * 0.5).toBe(BOARD_MARGIN)
    expect(view.scale).toBe(0.5)
  })
  test('a card bigger than the viewport keeps its top left in view', () => {
    const view = keepInView({ x: 0, y: 0, scale: 2 }, { left: 300, top: 100, width: 600, height: 400 }, viewport)
    expect(view.x + 300 * 2).toBe(BOARD_MARGIN)
    expect(view.y + 100 * 2).toBe(BOARD_MARGIN)
  })
})

describe('wheelZoom', () => {
  test('scrolling up zooms in, down zooms out, and nothing stays put', () => {
    expect(wheelZoom(-10)).toBeGreaterThan(1)
    expect(wheelZoom(10)).toBeLessThan(1)
    expect(wheelZoom(0)).toBe(1)
  })
  test('a mouse wheel notch is capped so one tick is not a leap', () => {
    expect(wheelZoom(-1000)).toBe(wheelZoom(-50))
  })
})
