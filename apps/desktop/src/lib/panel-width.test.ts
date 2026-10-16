import { describe, expect, test } from 'bun:test'
import { clampWidth, readWidth, runPanelLimits, sidebarLimits, writeWidth, type WidthStorage } from '@/lib/panel-width'

function memory(initial: Record<string, string> = {}): WidthStorage & { values: Record<string, string> } {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  }
}

const throwing: WidthStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('limits', () => {
  test('the sidebar goes from 220 to 480 and the run panel starts at 420 with 320 at least', () => {
    expect(sidebarLimits.min).toBe(220)
    expect(sidebarLimits.max).toBe(480)
    expect(sidebarLimits.initial).toBeGreaterThanOrEqual(220)
    expect(sidebarLimits.initial).toBeLessThanOrEqual(480)
    expect(runPanelLimits.min).toBe(320)
    expect(runPanelLimits.initial).toBe(420)
    expect(runPanelLimits.max).toBeGreaterThan(runPanelLimits.initial)
  })
})

describe('clampWidth', () => {
  test('keeps a width inside the limits and rounds it to a whole pixel', () => {
    expect(clampWidth(300.4, sidebarLimits)).toBe(300)
    expect(clampWidth(100, sidebarLimits)).toBe(220)
    expect(clampWidth(900, sidebarLimits)).toBe(480)
    expect(clampWidth(220, sidebarLimits)).toBe(220)
    expect(clampWidth(480, sidebarLimits)).toBe(480)
  })

  test('a width that is not a number is the initial one', () => {
    expect(clampWidth(Number.NaN, sidebarLimits)).toBe(sidebarLimits.initial)
    expect(clampWidth(Number.POSITIVE_INFINITY, runPanelLimits)).toBe(runPanelLimits.initial)
  })
})

describe('readWidth', () => {
  test('reads a stored width and clamps it', () => {
    expect(readWidth(() => memory({ w: '360' }), 'w', sidebarLimits)).toBe(360)
    expect(readWidth(() => memory({ w: '9999' }), 'w', sidebarLimits)).toBe(480)
    expect(readWidth(() => memory({ w: '12' }), 'w', runPanelLimits)).toBe(320)
  })

  test('nothing stored, or something unreadable, is the initial width', () => {
    expect(readWidth(() => memory(), 'w', sidebarLimits)).toBe(sidebarLimits.initial)
    expect(readWidth(() => memory({ w: 'wide' }), 'w', sidebarLimits)).toBe(sidebarLimits.initial)
    expect(readWidth(() => memory({ w: '' }), 'w', runPanelLimits)).toBe(runPanelLimits.initial)
  })

  test('blocked storage is the initial width, whether reading or reaching it throws', () => {
    expect(readWidth(() => throwing, 'w', sidebarLimits)).toBe(sidebarLimits.initial)
    expect(
      readWidth(
        () => {
          throw new Error('no storage')
        },
        'w',
        sidebarLimits,
      ),
    ).toBe(sidebarLimits.initial)
  })
})

describe('writeWidth', () => {
  test('stores the clamped width and returns it', () => {
    const storage = memory()
    expect(writeWidth(() => storage, 'w', 1000, sidebarLimits)).toBe(480)
    expect(storage.values.w).toBe('480')
    expect(readWidth(() => storage, 'w', sidebarLimits)).toBe(480)
  })

  test('blocked storage still returns the clamped width', () => {
    expect(writeWidth(() => throwing, 'w', 10, runPanelLimits)).toBe(320)
  })
})
