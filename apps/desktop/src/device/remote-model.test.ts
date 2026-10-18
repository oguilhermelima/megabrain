import { describe, expect, test } from 'bun:test'
import type { WidthStorage } from '@/lib/panel-width'
import { clampRemote, defaultRemote, dragRemote, readRemote, remoteKey, remoteMargin, writeRemote, zoomBarBand } from '@/device/remote-model'

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

const view = { width: 800, height: 600 }
const remote = { width: 160, height: 120 }

describe('the remote stays inside the view', () => {
  test('a place inside is kept as is', () => {
    expect(clampRemote({ right: 200, bottom: 150 }, remote, view)).toEqual({ right: 200, bottom: 150 })
  })

  test('the default sits in the bottom-right corner, just above the zoom bar', () => {
    expect(defaultRemote).toEqual({ right: remoteMargin, bottom: zoomBarBand, collapsed: false })
    expect(clampRemote(defaultRemote, remote, view)).toEqual({ right: remoteMargin, bottom: zoomBarBand })
  })

  test('past the right or bottom edge it comes back to the margin, and never into the zoom bar’s band', () => {
    expect(clampRemote({ right: -40, bottom: 0 }, remote, view)).toEqual({ right: remoteMargin, bottom: zoomBarBand })
    expect(clampRemote({ right: 300, bottom: zoomBarBand - 1 }, remote, view)).toEqual({ right: 300, bottom: zoomBarBand })
  })

  test('past the left or top edge it stops a margin short of it', () => {
    expect(clampRemote({ right: 2000, bottom: 2000 }, remote, view)).toEqual({ right: view.width - remote.width - remoteMargin, bottom: view.height - remote.height - remoteMargin })
  })

  test('the folded handle, being smaller, may go further than the open remote', () => {
    const handle = { width: 36, height: 36 }
    expect(clampRemote({ right: 2000, bottom: 2000 }, handle, view)).toEqual({ right: 800 - 36 - remoteMargin, bottom: 600 - 36 - remoteMargin })
  })

  test('a view too small for it pins it to the bottom-right corner above the band', () => {
    expect(clampRemote({ right: 300, bottom: 300 }, remote, { width: 100, height: 100 })).toEqual({ right: remoteMargin, bottom: zoomBarBand })
  })

  test('a drag moves it with the pointer: right and down shrink the distances from those edges', () => {
    expect(dragRemote({ right: 100, bottom: 100 }, { x: 30, y: 20 })).toEqual({ right: 70, bottom: 80 })
    expect(dragRemote({ right: 100, bottom: 100 }, { x: -30, y: -20 })).toEqual({ right: 130, bottom: 120 })
  })
})

describe('the remote’s place and fold are remembered per viewer', () => {
  test('nothing stored is the default', () => {
    expect(readRemote(() => memory())).toEqual(defaultRemote)
  })

  test('what was written reads back, rounded to whole pixels', () => {
    const storage = memory()
    expect(writeRemote(() => storage, { right: 120.4, bottom: 90.6, collapsed: true })).toEqual({ right: 120.4, bottom: 90.6, collapsed: true })
    expect(JSON.parse(storage.values[remoteKey] ?? '')).toEqual({ right: 120, bottom: 91, collapsed: true })
    expect(readRemote(() => storage)).toEqual({ right: 120, bottom: 91, collapsed: true })
  })

  test('something else stored falls back field by field', () => {
    expect(readRemote(() => memory({ [remoteKey]: 'not json' }))).toEqual(defaultRemote)
    expect(readRemote(() => memory({ [remoteKey]: 'null' }))).toEqual(defaultRemote)
    expect(readRemote(() => memory({ [remoteKey]: '{"right":"x","bottom":40,"collapsed":1}' }))).toEqual({ right: defaultRemote.right, bottom: 40, collapsed: false })
  })

  test('storage that throws reads the default and still gives back the state written', () => {
    expect(readRemote(() => throwing)).toEqual(defaultRemote)
    expect(
      readRemote(() => {
        throw new Error('no storage')
      }),
    ).toEqual(defaultRemote)
    expect(writeRemote(() => throwing, { right: 30, bottom: 70, collapsed: false })).toEqual({ right: 30, bottom: 70, collapsed: false })
  })
})
