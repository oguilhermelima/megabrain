import { describe, expect, test } from 'bun:test'
import { sidebarLimits, sidebarSurface, type WidthStorage } from '@/lib/panel-width'
import { readPanelOpen, wikiPanelLimits, wikiPanelSurface, wikiPanels, wikiShellLayout, writePanelOpen } from '@/advanced/wiki-shell-model'

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

describe('wikiPanels', () => {
  test('each page remembers its own panel width and open state under its own keys', () => {
    const keys = [wikiPanels.knowledge.width, wikiPanels.knowledge.open, wikiPanels.artifacts.width, wikiPanels.artifacts.open]
    expect(new Set(keys).size).toBe(4)
    for (const key of keys) expect(key.startsWith('megabrain.')).toBe(true)
  })

  test('the panel is as narrow and as wide as the left sidebar may be', () => {
    expect(wikiPanelLimits).toEqual(sidebarLimits)
  })
})

describe('readPanelOpen', () => {
  test('nothing stored is open', () => {
    expect(readPanelOpen(() => memory(), 'k')).toBe(true)
  })

  test('a stored 0 is closed and a stored 1 is open', () => {
    expect(readPanelOpen(() => memory({ k: '0' }), 'k')).toBe(false)
    expect(readPanelOpen(() => memory({ k: '1' }), 'k')).toBe(true)
  })

  test('something else stored, or storage that throws, is open', () => {
    expect(readPanelOpen(() => memory({ k: 'closed' }), 'k')).toBe(true)
    expect(readPanelOpen(() => throwing, 'k')).toBe(true)
    expect(
      readPanelOpen(() => {
        throw new Error('no storage')
      }, 'k'),
    ).toBe(true)
  })
})

describe('writePanelOpen', () => {
  test('writes 1 or 0 and reads back the same', () => {
    const storage = memory()
    expect(writePanelOpen(() => storage, 'k', false)).toBe(false)
    expect(storage.values.k).toBe('0')
    expect(readPanelOpen(() => storage, 'k')).toBe(false)
    expect(writePanelOpen(() => storage, 'k', true)).toBe(true)
    expect(storage.values.k).toBe('1')
  })

  test('storage that throws still gives the state asked for', () => {
    expect(writePanelOpen(() => throwing, 'k', false)).toBe(false)
  })
})

describe('wikiShellLayout', () => {
  test('an open panel stands beside the bar, from the top, and holds its own toggle', () => {
    expect(wikiShellLayout(true, true)).toEqual({ panel: true, barToggle: false })
  })

  test('a closed panel leaves its toggle in the bar', () => {
    expect(wikiShellLayout(true, false)).toEqual({ panel: false, barToggle: true })
  })

  test('a page without a panel has neither', () => {
    expect(wikiShellLayout(false, true)).toEqual({ panel: false, barToggle: false })
    expect(wikiShellLayout(false, false)).toEqual({ panel: false, barToggle: false })
  })
})

describe('wikiPanelSurface', () => {
  test('the panel is drawn with the left sidebar’s surface, its hairline on the edge it faces', () => {
    expect(wikiPanelSurface).toBe(sidebarSurface('right'))
    expect(sidebarSurface('left').replace('border-r', 'border-l')).toBe(sidebarSurface('right'))
    expect(sidebarSurface('left').split(' ')).toContain('glass')
  })
})
