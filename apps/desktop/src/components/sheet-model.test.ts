import { describe, expect, test } from 'bun:test'
import { emptySheetMemory, focusBack, readSheetMemory, sheetKey, sheetLimits, writeSheetMemory } from '@/components/sheet-model'
import type { WidthStorage } from '@/lib/panel-width'

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

describe('sheet memory', () => {
  test('nothing stored reads as a floating, closed sheet at the initial width', () => {
    const store = memory()
    expect(readSheetMemory(() => store, 'filters')).toEqual(emptySheetMemory)
    expect(emptySheetMemory.width).toBe(sheetLimits.initial)
  })

  test('a pinned sheet reads back as it was written, per id', () => {
    const store = memory()
    writeSheetMemory(() => store, 'tasks.filters', { pinned: true, open: true, width: 400 })
    expect(readSheetMemory(() => store, 'tasks.filters')).toEqual({ pinned: true, open: true, width: 400 })
    expect(readSheetMemory(() => store, 'github.filters')).toEqual(emptySheetMemory)
  })

  test('an unpinned sheet never remembers being open', () => {
    const store = memory()
    expect(writeSheetMemory(() => store, 'a', { pinned: false, open: true, width: 320 }).open).toBe(false)
    store.values[sheetKey('b')] = JSON.stringify({ pinned: false, open: true, width: 320 })
    expect(readSheetMemory(() => store, 'b').open).toBe(false)
  })

  test('widths are clamped on the way in and the way out', () => {
    const store = memory()
    expect(writeSheetMemory(() => store, 'a', { pinned: true, open: true, width: 9000 }).width).toBe(sheetLimits.max)
    store.values[sheetKey('b')] = JSON.stringify({ pinned: true, open: true, width: 10 })
    expect(readSheetMemory(() => store, 'b').width).toBe(sheetLimits.min)
    expect(writeSheetMemory(() => store, 'c', { pinned: true, open: true, width: Number.NaN }).width).toBe(sheetLimits.initial)
  })

  test('bad data reads as nothing stored, field by field', () => {
    const store = memory({
      [sheetKey('garbage')]: '{not json',
      [sheetKey('array')]: '[1,2]',
      [sheetKey('strings')]: JSON.stringify({ pinned: 'yes', open: 'yes', width: '400' }),
      [sheetKey('partial')]: JSON.stringify({ pinned: true, open: true, width: null }),
    })
    expect(readSheetMemory(() => store, 'garbage')).toEqual(emptySheetMemory)
    expect(readSheetMemory(() => store, 'array')).toEqual(emptySheetMemory)
    expect(readSheetMemory(() => store, 'strings')).toEqual(emptySheetMemory)
    expect(readSheetMemory(() => store, 'partial')).toEqual({ pinned: true, open: true, width: sheetLimits.initial })
  })

  test('blocked storage remembers nothing and never throws', () => {
    expect(readSheetMemory(() => throwing, 'a')).toEqual(emptySheetMemory)
    expect(writeSheetMemory(() => throwing, 'a', { pinned: true, open: true, width: 333 })).toEqual({ pinned: true, open: true, width: 333 })
    expect(
      readSheetMemory(() => {
        throw new Error('no localStorage')
      }, 'a'),
    ).toEqual(emptySheetMemory)
  })
})

describe('focus on close', () => {
  test('goes back to the element focused before, while it is still on the page', () => {
    const trigger = { isConnected: true }
    expect(focusBack(trigger)).toBe(trigger)
    expect(focusBack({ isConnected: false })).toBeNull()
    expect(focusBack(null)).toBeNull()
  })
})
