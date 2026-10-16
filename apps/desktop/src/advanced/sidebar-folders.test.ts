import { describe, expect, test } from 'bun:test'
import {
  createFolder,
  deleteFolder,
  emptyLayout,
  flattenLayout,
  layoutDropTarget,
  moveEntry,
  moveToFolder,
  parseLayout,
  reconcileLayout,
  renameFolder,
  sidebarEntries,
  stepEntry,
  toggleFolder,
  type SidebarLayout,
} from '@/advanced/sidebar-folders'

const layout = (order: string[], folders: SidebarLayout['folders'] = []): SidebarLayout => ({ folders, order })
const folder = (id: string, projects: string[], name = id, collapsed = false) => ({ id, name, collapsed, projects })

describe('parseLayout', () => {
  test('reads a saved layout', () => {
    const saved = { folders: [folder('work', ['/a'])], order: ['work', '/b'] }
    expect(parseLayout(saved)).toEqual(saved)
  })

  test('starts empty from anything that is not a layout', () => {
    expect(parseLayout(null)).toEqual(emptyLayout)
    expect(parseLayout('nope')).toEqual(emptyLayout)
    expect(parseLayout({ folders: 3, order: 'x' })).toEqual(emptyLayout)
  })

  test('drops malformed folders and entries but keeps the good ones', () => {
    const parsed = parseLayout({
      folders: [folder('ok', ['/a', 7 as unknown as string]), { id: 3, name: 'bad' }, { id: '/path-like', name: 'bad', collapsed: false, projects: [] }, folder('ok', ['/dup'])],
      order: ['ok', 9, '/b'],
    })
    expect(parsed).toEqual({ folders: [folder('ok', ['/a'])], order: ['ok', '/b'] })
  })
})

describe('reconcileLayout', () => {
  test('ignores stale project paths in folders and at top level', () => {
    const saved = layout(['/gone', 'work', '/b'], [folder('work', ['/a', '/missing'])])
    expect(reconcileLayout(saved, ['/a', '/b'])).toEqual(layout(['work', '/b'], [folder('work', ['/a'])]))
  })

  test('keeps empty folders and appends folders the order forgot', () => {
    expect(reconcileLayout(layout(['/a'], [folder('empty', [])]), ['/a'])).toEqual(layout(['/a', 'empty'], [folder('empty', [])]))
  })

  test('puts projects it does not know at the end of the top level, in the order they arrive', () => {
    expect(reconcileLayout(layout(['/b']), ['/a', '/b', '/c'])).toEqual(layout(['/b', '/a', '/c']))
  })

  test('a project in a folder is not also listed at the top level, and lives in one folder only', () => {
    const saved = layout(['/a', 'one', 'two'], [folder('one', ['/a']), folder('two', ['/a', '/b'])])
    expect(reconcileLayout(saved, ['/a', '/b'])).toEqual(layout(['one', 'two'], [folder('one', ['/a']), folder('two', ['/b'])]))
  })
})

describe('flattenLayout', () => {
  test('lists project paths as shown, a folder\'s projects in its place', () => {
    expect(flattenLayout(layout(['/a', 'work', '/d'], [folder('work', ['/b', '/c'])]))).toEqual(['/a', '/b', '/c', '/d'])
  })
})

describe('createFolder', () => {
  test('a new folder goes on top, expanded and empty', () => {
    expect(createFolder(layout(['/a']), 'new', 'Clients')).toEqual(layout(['new', '/a'], [folder('new', [], 'Clients')]))
  })

  test('a folder made for a project takes the project\'s place and holds it', () => {
    expect(createFolder(layout(['/a', '/b', '/c']), 'new', 'Mine', '/b')).toEqual(layout(['/a', 'new', '/c'], [folder('new', ['/b'], 'Mine')]))
  })

  test('a blank name becomes New folder', () => {
    expect(createFolder(emptyLayout, 'new', '   ').folders[0]?.name).toBe('New folder')
  })
})

describe('renameFolder', () => {
  test('renames with the name trimmed', () => {
    expect(renameFolder(layout(['f'], [folder('f', [], 'Old')]), 'f', '  New ').folders[0]?.name).toBe('New')
  })

  test('a blank name keeps the old one', () => {
    const before = layout(['f'], [folder('f', [], 'Old')])
    expect(renameFolder(before, 'f', ' ')).toEqual(before)
  })
})

describe('deleteFolder', () => {
  test('its projects return to the top level where the folder was', () => {
    expect(deleteFolder(layout(['/a', 'f', '/d'], [folder('f', ['/b', '/c'])]), 'f')).toEqual(layout(['/a', '/b', '/c', '/d']))
  })
})

describe('toggleFolder', () => {
  test('flips a folder between collapsed and expanded', () => {
    const toggled = toggleFolder(layout(['f'], [folder('f', [])]), 'f')
    expect(toggled.folders[0]?.collapsed).toBe(true)
    expect(toggleFolder(toggled, 'f').folders[0]?.collapsed).toBe(false)
  })
})

describe('moveToFolder', () => {
  test('moves a top-level project to the end of a folder', () => {
    expect(moveToFolder(layout(['/a', 'f'], [folder('f', ['/b'])]), '/a', 'f')).toEqual(layout(['f'], [folder('f', ['/b', '/a'])]))
  })

  test('moves a project between folders', () => {
    expect(moveToFolder(layout(['f', 'g'], [folder('f', ['/a']), folder('g', [])]), '/a', 'g')).toEqual(layout(['f', 'g'], [folder('f', []), folder('g', ['/a'])]))
  })

  test('back to the top level it lands right after the folder it left', () => {
    expect(moveToFolder(layout(['f', '/z'], [folder('f', ['/a', '/b'])]), '/a', null)).toEqual(layout(['f', '/a', '/z'], [folder('f', ['/b'])]))
  })
})

describe('moveEntry', () => {
  const start = layout(['/a', 'f', '/d'], [folder('f', ['/b', '/c'])])

  test('reorders folders and projects together at the top level', () => {
    expect(moveEntry(start, 'f', { key: '/a', placement: 'before' }).order).toEqual(['f', '/a', '/d'])
    expect(moveEntry(start, '/d', { key: 'f', placement: 'before' }).order).toEqual(['/a', '/d', 'f'])
  })

  test('drops a project into a folder', () => {
    expect(moveEntry(start, '/a', { key: 'f', placement: 'into' })).toEqual(layout(['f', '/d'], [folder('f', ['/b', '/c', '/a'])]))
  })

  test('drops a project next to one inside a folder', () => {
    expect(moveEntry(start, '/d', { key: '/c', placement: 'before' })).toEqual(layout(['/a', 'f'], [folder('f', ['/b', '/d', '/c'])]))
  })

  test('drags a project out of a folder next to a top-level one', () => {
    expect(moveEntry(start, '/b', { key: '/d', placement: 'after' })).toEqual(layout(['/a', 'f', '/d', '/b'], [folder('f', ['/c'])]))
  })

  test('reorders inside a folder', () => {
    expect(moveEntry(start, '/c', { key: '/b', placement: 'before' }).folders[0]?.projects).toEqual(['/c', '/b'])
  })

  test('a folder dropped beside a project inside another folder lands beside that folder', () => {
    const two = layout(['f', 'g'], [folder('f', ['/b']), folder('g', [])])
    expect(moveEntry(two, 'g', { key: '/b', placement: 'before' }).order).toEqual(['g', 'f'])
  })

  test('folders never nest, and dropping on itself changes nothing', () => {
    expect(moveEntry(start, 'f', { key: 'f', placement: 'into' })).toEqual(start)
    expect(moveEntry(start, '/a', { key: '/a', placement: 'after' })).toEqual(start)
  })
})

describe('stepEntry', () => {
  const start = layout(['/a', 'f', '/d'], [folder('f', ['/b', '/c'])])

  test('moves a top-level entry past its visible neighbour', () => {
    expect(stepEntry(start, '/d', -1, new Set(['/a', '/b', '/c', '/d'])).order).toEqual(['/a', '/d', 'f'])
    expect(stepEntry(start, 'f', 1, new Set(['/a', '/b', '/c', '/d'])).order).toEqual(['/a', '/d', 'f'])
  })

  test('moves inside a folder without leaving it', () => {
    expect(stepEntry(start, '/c', -1, new Set(['/a', '/b', '/c', '/d'])).folders[0]?.projects).toEqual(['/c', '/b'])
    expect(stepEntry(start, '/b', -1, new Set(['/a', '/b', '/c', '/d']))).toEqual(start)
  })

  test('skips projects that are not shown', () => {
    expect(stepEntry(layout(['/a', '/hidden', '/c']), '/c', -1, new Set(['/a', '/c'])).order).toEqual(['/c', '/a', '/hidden'])
  })
})

describe('layoutDropTarget', () => {
  // A top-level project, an expanded folder with one project, and a top-level project.
  const rows = [
    { key: '/a', parent: null, folder: false, open: false, top: 0, bottom: 40 },
    { key: 'f', parent: null, folder: true, open: true, top: 40, bottom: 80 },
    { key: '/b', parent: 'f', folder: false, open: false, top: 80, bottom: 120 },
    { key: '/d', parent: null, folder: false, open: false, top: 120, bottom: 160 },
  ]

  test('a project over the middle of a folder header goes into it', () => {
    expect(layoutDropTarget(rows, 60, '/a')).toEqual({ key: 'f', placement: 'into' })
  })

  test('a project over the top edge of a folder header goes before the folder', () => {
    expect(layoutDropTarget(rows, 42, '/d')).toEqual({ key: 'f', placement: 'before' })
  })

  test('a project over a row inside a folder lands beside it', () => {
    expect(layoutDropTarget(rows, 115, '/a')).toEqual({ key: '/b', placement: 'after' })
  })

  test('a folder only sees top-level rows and halves of them', () => {
    expect(layoutDropTarget(rows, 100, 'f')).toBeNull()
    expect(layoutDropTarget(rows, 10, 'f')).toEqual({ key: '/a', placement: 'before' })
  })

  test('below every row lands after the last top-level entry', () => {
    const lastInFolder = rows.slice(0, 3)
    expect(layoutDropTarget(lastInFolder, 200, '/a')).toEqual({ key: 'f', placement: 'after' })
  })

  test('over itself there is no target', () => {
    expect(layoutDropTarget(rows, 20, '/a')).toBeNull()
  })
})

describe('sidebarEntries', () => {
  const project = (path: string, name: string) => ({ path, name })
  const twins = [project('/w/local/userscripts', 'userscripts'), project('/w/userscripts', 'userscripts'), project('/w/qs-tiles', 'qs-tiles'), project('/w/megabrain', 'megabrain')]
  const shown = new Map(twins.map((item) => [item.path, item]))
  const saved = layout(['/w/megabrain', 'local'], [folder('local', ['/w/qs-tiles', '/w/local/userscripts', '/w/userscripts'])])

  test('two projects with the same name in a folder are two entries, keyed by path', () => {
    const entries = sidebarEntries(saved, shown, false)
    expect(entries.map((entry) => entry.key)).toEqual(['/w/megabrain', 'local'])
    const inside = entries[1]?.kind === 'folder' ? entries[1].projects : []
    expect(inside.map((item) => item.path)).toEqual(['/w/qs-tiles', '/w/local/userscripts', '/w/userscripts'])
  })

  test('a folder counts the projects it shows', () => {
    const partial = new Map([...shown].filter(([path]) => path !== '/w/qs-tiles'))
    const entries = sidebarEntries(saved, partial, false)
    expect(entries[1]?.kind === 'folder' ? entries[1].projects.length : -1).toBe(2)
  })

  test('filtering drops a folder with nothing shown; without filters it stays', () => {
    const none = new Map([['/w/megabrain', project('/w/megabrain', 'megabrain')]])
    expect(sidebarEntries(saved, none, true).map((entry) => entry.key)).toEqual(['/w/megabrain'])
    expect(sidebarEntries(saved, none, false).map((entry) => entry.key)).toEqual(['/w/megabrain', 'local'])
  })

  test('every project shows exactly once after a run of moves', () => {
    const paths = twins.map((item) => item.path)
    let current = reconcileLayout(saved, paths)
    const moves: Array<[string, { key: string; placement: 'before' | 'after' | 'into' }]> = [
      ['/w/userscripts', { key: '/w/megabrain', placement: 'before' }],
      ['/w/userscripts', { key: 'local', placement: 'into' }],
      ['/w/local/userscripts', { key: '/w/megabrain', placement: 'after' }],
      ['local', { key: '/w/userscripts', placement: 'before' }],
      ['/w/qs-tiles', { key: '/w/userscripts', placement: 'after' }],
    ]
    for (const [source, target] of moves) {
      current = reconcileLayout(moveEntry(current, source, target), paths)
      const rendered = sidebarEntries(current, shown, false).flatMap((entry) => (entry.kind === 'folder' ? entry.projects.map((item) => item.path) : [entry.key]))
      expect([...rendered].sort()).toEqual([...paths].sort())
    }
  })
})

describe('reconcileLayout is idempotent', () => {
  test('reconciling twice changes nothing, and each path is placed once', () => {
    const messy = layout(['/a', 'f', '/a', '/b', 'g', '/gone'], [folder('f', ['/b', '/c', '/b']), folder('g', ['/c', '/d'])])
    const paths = ['/a', '/b', '/c', '/d', '/e']
    const once = reconcileLayout(messy, paths)
    expect(reconcileLayout(once, paths)).toEqual(once)
    expect(flattenLayout(once).sort()).toEqual(paths)
  })
})
