import { describe, expect, test } from 'bun:test'
import type { KnowledgeKind, KnowledgeTopicSummary } from '@/api/schema'
import { type Box, type MapFilter, fitCap, fitView, layoutMap, linkTypes, mapLinks, stepFrom, zoomAt, zoomLimits } from '@/advanced/knowledge-map'

const kinds: KnowledgeKind[] = ['feat', 'fix', 'refactor', 'decision', 'investigation']

const topic = (id: string, extra: Partial<KnowledgeTopicSummary> = {}): KnowledgeTopicSummary => ({
  id,
  project: '/work/canto',
  title: `Topic ${id}`,
  kind: 'feat',
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
  aliases: [],
  overview: 'what it is',
  chats: [],
  refs: [],
  activity: 1,
  ...extra,
})

/** A seeded generator, so the 60 topics are the same on every run. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

const words = ['player', 'seek', 'onboarding', 'grid', 'search', 'debounce', 'carousel', 'context', 'summaries', 'worktree', 'dispatch', 'pane', 'queue', 'sidebar']

/** 60 topics of every kind, unevenly spread, with long titles and shared chats, files and refs. */
function sixty(): KnowledgeTopicSummary[] {
  const next = random(7)
  return Array.from({ length: 60 }, (_, n) => {
    const kind = kinds[Math.floor(next() * next() * kinds.length)] ?? 'feat'
    const length = 1 + Math.floor(next() * 6)
    const title = Array.from({ length }, () => words[Math.floor(next() * words.length)] ?? 'topic').join(' ')
    const chats = Array.from({ length: Math.floor(next() * 3) }, () => `chat-${Math.floor(next() * 40)}`)
    const files = Array.from({ length: Math.floor(next() * 3) }, () => ({ kind: 'file' as const, id: `src/file-${Math.floor(next() * 30)}.ts` }))
    const prs = next() < 0.3 ? [{ kind: 'pr' as const, id: String(400 + Math.floor(next() * 10)) }] : []
    return topic(`t${n}`, {
      title: `${title[0]?.toUpperCase() ?? ''}${title.slice(1)}`,
      kind,
      status: next() < 0.6 ? 'shipped' : next() < 0.8 ? 'active' : 'dropped',
      activity: Math.floor(next() * 30),
      updatedAt: new Date(Date.UTC(2026, 9, 1) + Math.floor(next() * 16 * 86_400_000)).toISOString(),
      chats,
      refs: [...files, ...prs],
    })
  })
}

const seven = (): KnowledgeTopicSummary[] => [
  topic('seek', { title: 'Player seek', kind: 'fix', status: 'shipped', activity: 12, chats: ['c1', 'c2'], refs: [{ kind: 'file', id: 'apps/tv/seek.ts' }, { kind: 'pr', id: '412' }] }),
  topic('onboarding', { title: 'Onboarding steps', kind: 'refactor', activity: 3, chats: ['c1'], refs: [{ kind: 'file', id: 'apps/tv/seek.ts' }] }),
  topic('carousel', { title: 'Home carousel', kind: 'feat', status: 'dropped', activity: 1 }),
  topic('grid', { title: 'Home grid', kind: 'feat', status: 'shipped', activity: 4, refs: [{ kind: 'pr', id: '371' }] }),
  topic('debounce', { title: 'Search debounce', kind: 'fix', status: 'shipped', activity: 2, refs: [{ kind: 'pr', id: '371' }] }),
  topic('trpc', { title: 'One tRPC React context', kind: 'investigation', status: 'shipped', activity: 5 }),
  topic('tv', { title: 'TV before phone', kind: 'decision', activity: 2, refs: [{ kind: 'file', id: 'apps/tv/seek.ts' }] }),
]

const overlap = (left: Box, right: Box) => left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height
const inside = (box: Box, outer: Box) => box.x >= outer.x - 1e-6 && box.y >= outer.y - 1e-6 && box.x + box.width <= outer.x + outer.width + 1e-6 && box.y + box.height <= outer.y + outer.height + 1e-6
const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const distance = (left: { x: number; y: number }, right: { x: number; y: number }) => Math.hypot(left.x - right.x, left.y - right.y)
const viewport = { width: 960, height: 640 }
const padding = 32

describe('layoutMap clusters by kind', () => {
  test('each kind gets one region holding exactly its topics, in the fixed kind order when nothing links them', () => {
    const layout = layoutMap(seven().map(({ chats: _chats, refs: _refs, ...rest }) => ({ ...rest, chats: [], refs: [] })))
    expect(layout.regions.map((region) => region.kind)).toEqual(['feat', 'fix', 'refactor', 'decision', 'investigation'])
    for (const region of layout.regions) {
      const own = layout.topics.filter((entry) => entry.kind === region.kind)
      expect(region.count).toBe(own.length)
      for (const entry of own) expect(inside(entry.box, region.box)).toBe(true)
      for (const entry of layout.topics.filter((other) => other.kind !== region.kind)) expect(overlap(entry.box, region.box)).toBe(false)
    }
  })

  test('regions never overlap, for 7 and for 60 topics', () => {
    for (const topics of [seven(), sixty()]) {
      const { regions } = layoutMap(topics, { aspect: 1.5 })
      for (const left of regions) for (const right of regions) if (left !== right) expect(overlap(left.box, right.box)).toBe(false)
    }
  })

  test('a region is labelled with its kind and how many topics it holds', () => {
    const fix = layoutMap(seven()).regions.find((region) => region.kind === 'fix')
    expect(fix?.label).toBe('Fixes')
    expect(fix?.count).toBe(2)
  })

  test('the most active topic of a kind sits nearest its region centre', () => {
    const topics = Array.from({ length: 9 }, (_, n) => topic(`f${n}`, { activity: n === 4 ? 40 : n }))
    const layout = layoutMap(topics)
    const region = layout.regions[0]
    if (region === undefined) throw new Error('no region')
    const middle = centre(region.box)
    const nearest = [...layout.topics].sort((left, right) => distance(left, middle) - distance(right, middle))[0]
    expect(nearest?.id).toBe('f4')
  })

  test('among equally active topics the most recently updated is the most central', () => {
    const topics = Array.from({ length: 7 }, (_, n) => topic(`f${n}`, { activity: 2, updatedAt: `2026-10-1${n}T10:00:00.000Z` }))
    const layout = layoutMap(topics)
    const region = layout.regions[0]
    if (region === undefined) throw new Error('no region')
    const middle = centre(region.box)
    expect([...layout.topics].sort((left, right) => distance(left, middle) - distance(right, middle))[0]?.id).toBe('f6')
  })

  test('a topic linked to another kind sits on that kind’s side of its own region', () => {
    const feats = Array.from({ length: 8 }, (_, n) => topic(`f${n}`, { activity: 8 - n }))
    const fixes = Array.from({ length: 8 }, (_, n) => topic(`x${n}`, { kind: 'fix', activity: 8 - n }))
    const linked = feats.map((entry) => (entry.id === 'f7' ? { ...entry, chats: ['shared'] } : entry))
    const partners = fixes.map((entry) => (entry.id === 'x7' ? { ...entry, chats: ['shared'] } : entry))
    const layout = layoutMap([...linked, ...partners], { aspect: 1.5 })
    const fixRegion = layout.regions.find((region) => region.kind === 'fix')
    if (fixRegion === undefined) throw new Error('no fix region')
    const target = centre(fixRegion.box)
    const others = layout.topics.filter((entry) => entry.kind === 'feat' && entry.id !== 'f7').map((entry) => distance(entry, target))
    const median = [...others].sort((left, right) => left - right)[Math.floor(others.length / 2)] ?? 0
    const pulled = layout.topics.find((entry) => entry.id === 'f7')
    if (pulled === undefined) throw new Error('no f7')
    expect(distance(pulled, target)).toBeLessThan(median)
  })

  test('kinds that share links sit next to each other', () => {
    const topics = [
      ...['a', 'b', 'c'].map((id) => topic(`feat-${id}`)),
      ...['a', 'b', 'c'].map((id) => topic(`fix-${id}`, { kind: 'fix' })),
      ...['a', 'b', 'c'].map((id) => topic(`refactor-${id}`, { kind: 'refactor', chats: ['shared'] })),
      ...['a', 'b', 'c'].map((id) => topic(`decision-${id}`, { kind: 'decision' })),
      ...['a', 'b', 'c'].map((id) => topic(`investigation-${id}`, { kind: 'investigation', chats: ['shared'] })),
    ]
    const layout = layoutMap(topics, { aspect: 4 })
    const order = [...layout.regions].sort((left, right) => left.box.x - right.box.x).map((region) => region.kind)
    expect(Math.abs(order.indexOf('refactor') - order.indexOf('investigation'))).toBe(1)
  })

  test('the same topics lay out the same way every time', () => {
    expect(layoutMap(sixty(), { aspect: 1.5 })).toEqual(layoutMap(sixty(), { aspect: 1.5 }))
  })

  test('no topics is an empty map', () => {
    const layout = layoutMap([])
    expect(layout.topics).toEqual([])
    expect(layout.regions).toEqual([])
    expect(layout.links).toEqual([])
  })
})

describe('layoutMap labels', () => {
  test('no two topics, circle and label, overlap among 60', () => {
    const { topics } = layoutMap(sixty(), { aspect: 1.5 })
    expect(topics).toHaveLength(60)
    for (let i = 0; i < topics.length; i++) for (let j = i + 1; j < topics.length; j++) expect(overlap((topics[i] as { box: Box }).box, (topics[j] as { box: Box }).box)).toBe(false)
  })

  test('each topic’s box holds its circle and its label', () => {
    for (const entry of layoutMap(sixty()).topics) {
      expect(inside({ x: entry.x - entry.radius, y: entry.y - entry.radius, width: entry.radius * 2, height: entry.radius * 2 }, entry.box)).toBe(true)
      expect(inside(entry.labelBox, entry.box)).toBe(true)
      expect(entry.labelBox.y).toBeGreaterThan(entry.y + entry.radius)
    }
  })

  test('a long title is cut with an ellipsis to the label width, and keeps its full title', () => {
    const measure = (text: string) => text.length * 7
    const long = 'A topic whose title runs on far longer than any label could hold'
    const placed = layoutMap([topic('a', { title: long })], { measure }).topics[0]
    expect(placed?.title).toBe(long)
    expect(placed?.label.endsWith('…')).toBe(true)
    expect(long.startsWith(placed?.label.slice(0, -1) ?? '')).toBe(true)
    expect(measure(placed?.label ?? '')).toBeLessThanOrEqual(placed?.labelBox.width ?? 0)
  })

  test('a short title is kept whole', () => {
    expect(layoutMap([topic('a', { title: 'Home grid' })]).topics[0]?.label).toBe('Home grid')
  })

  test('busier topics are drawn larger, and nodes shrink as the map grows', () => {
    const { topics } = layoutMap(seven())
    const radius = (id: string) => topics.find((entry) => entry.id === id)?.radius ?? 0
    expect(radius('seek')).toBeGreaterThan(radius('carousel'))
    const crowded = layoutMap(sixty()).topics
    const most = (list: { radius: number }[]) => Math.max(...list.map((entry) => entry.radius))
    expect(most(crowded)).toBeLessThan(most(layoutMap([topic('a', { activity: 29 })]).topics))
  })
})

describe('fitView', () => {
  const cases: [string, KnowledgeTopicSummary[]][] = [
    ['1 topic', [topic('only', { activity: 3 })]],
    ['7 topics', seven()],
    ['60 topics', sixty()],
  ]
  for (const [name, topics] of cases) {
    test(`${name}: everything lands inside the padded viewport, and the map fills it unless it would grow past the cap`, () => {
      const layout = layoutMap(topics, { aspect: viewport.width / viewport.height })
      const view = fitView(layout.bounds, viewport, padding)
      const screen = (box: Box): Box => ({ x: box.x * view.scale + view.x, y: box.y * view.scale + view.y, width: box.width * view.scale, height: box.height * view.scale })
      const frame = { x: padding, y: padding, width: viewport.width - padding * 2, height: viewport.height - padding * 2 }
      for (const entry of layout.topics) expect(inside(screen(entry.box), frame)).toBe(true)
      for (const region of layout.regions) expect(inside(screen(region.box), frame)).toBe(true)
      const shown = screen(layout.bounds)
      const fills = Math.abs(shown.width - frame.width) < 1 || Math.abs(shown.height - frame.height) < 1
      expect(fills || view.scale === fitCap).toBe(true)
      expect(view.scale).toBeLessThanOrEqual(fitCap)
      const middle = centre(shown)
      expect(Math.abs(middle.x - viewport.width / 2)).toBeLessThan(1)
      expect(Math.abs(middle.y - viewport.height / 2)).toBeLessThan(1)
    })
  }

  test('60 topics stay readable when fitted: at least 0.7 of their size', () => {
    const layout = layoutMap(sixty(), { aspect: viewport.width / viewport.height })
    expect(fitView(layout.bounds, viewport, padding).scale).toBeGreaterThanOrEqual(0.7)
  })
})

describe('zoomAt', () => {
  test('zooms about the point under the cursor, which stays put', () => {
    const view = { x: 10, y: 20, scale: 1 }
    const at = { x: 300, y: 200 }
    const next = zoomAt(view, 2, at)
    const world = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale }
    expect(next.scale).toBe(2)
    expect(world.x * next.scale + next.x).toBeCloseTo(at.x)
    expect(world.y * next.scale + next.y).toBeCloseTo(at.y)
  })

  test('stops at the zoom limits', () => {
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 100, { x: 0, y: 0 }).scale).toBe(zoomLimits.max)
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0.001, { x: 0, y: 0 }).scale).toBe(zoomLimits.min)
  })
})

describe('mapLinks', () => {
  const edges = [
    { source: 'a', target: 'b', chats: 2, files: 1, refs: 0 },
    { source: 'a', target: 'c', chats: 0, files: 0, refs: 3 },
  ]
  const every = new Set(linkTypes.map((entry) => entry.type))

  test('a link weighs as many chats, files and refs as the two share', () => {
    expect(mapLinks(edges, every).map((link) => [link.source, link.target, link.weight])).toEqual([
      ['a', 'b', 3],
      ['a', 'c', 3],
    ])
  })

  test('a link type turned off stops counting, and a link left with nothing is dropped', () => {
    expect(mapLinks(edges, new Set(['chats'] as const)).map((link) => [link.source, link.target, link.weight])).toEqual([['a', 'b', 2]])
    expect(mapLinks(edges, new Set())).toEqual([])
  })

  test('the layout weighs its links the same way', () => {
    const layout = layoutMap(seven())
    const seekOnboarding = layout.links.find((link) => link.source === 'seek' && link.target === 'onboarding')
    expect(seekOnboarding).toMatchObject({ chats: 1, files: 1, refs: 0, weight: 2 })
  })
})

describe('filters', () => {
  test('a hidden kind takes its topics, region and links off the map', () => {
    const filter: MapFilter = { kinds: new Set<KnowledgeKind>(['feat', 'refactor', 'decision', 'investigation']), links: new Set(linkTypes.map((entry) => entry.type)) }
    const layout = layoutMap(seven(), { filter })
    expect(layout.topics.some((entry) => entry.kind === 'fix')).toBe(false)
    expect(layout.regions.map((region) => region.kind)).not.toContain('fix')
    expect(layout.links.some((link) => link.source === 'seek' || link.target === 'seek' || link.source === 'debounce' || link.target === 'debounce')).toBe(false)
  })

  test('a hidden link type draws no link of its own, and the topic counts only what is shown', () => {
    const filter: MapFilter = { kinds: new Set(kinds), links: new Set(['files'] as const) }
    const layout = layoutMap(seven(), { filter })
    expect(layout.links.map((link) => `${link.source}-${link.target}`).sort()).toEqual(['onboarding-tv', 'seek-onboarding', 'seek-tv'].sort())
    expect(layout.links.every((link) => link.weight === link.files)).toBe(true)
    expect(layout.topics.find((entry) => entry.id === 'seek')?.shared).toEqual({ chats: 0, files: 1, refs: 0, topics: 2 })
  })

  test('a topic counts each chat, file and ref it shares with other topics once', () => {
    const seek = layoutMap(seven()).topics.find((entry) => entry.id === 'seek')
    expect(seek?.shared).toEqual({ chats: 1, files: 1, refs: 0, topics: 2 })
    const grid = layoutMap(seven()).topics.find((entry) => entry.id === 'grid')
    expect(grid?.shared).toEqual({ chats: 0, files: 0, refs: 1, topics: 1 })
  })
})

describe('stepFrom', () => {
  //        n
  //  w     c     e   far
  //        s
  const points = [
    { id: 'c', x: 0, y: 0 },
    { id: 'e', x: 100, y: 10 },
    { id: 'far', x: 300, y: 0 },
    { id: 'w', x: -100, y: 0 },
    { id: 'n', x: 0, y: -100 },
    { id: 's', x: 5, y: 100 },
  ]

  test('an arrow moves to the nearest topic that way', () => {
    expect(stepFrom(points, [], 'c', 'right')).toBe('e')
    expect(stepFrom(points, [], 'c', 'left')).toBe('w')
    expect(stepFrom(points, [], 'c', 'up')).toBe('n')
    expect(stepFrom(points, [], 'c', 'down')).toBe('s')
  })

  test('walking right visits topics left to right, and stops at the edge', () => {
    const visited: string[] = []
    let at: string | null = 'w'
    while (at !== null) {
      visited.push(at)
      at = stepFrom(points, [], at, 'right')
    }
    expect(visited).toEqual(['w', 'c', 'e', 'far'])
  })

  test('a linked topic that way wins over a slightly nearer unlinked one', () => {
    expect(stepFrom(points, [{ source: 'c', target: 'far' }], 'c', 'right')).toBe('e')
    const close = [...points, { id: 'linked', x: 130, y: 0 }]
    expect(stepFrom(close, [{ source: 'linked', target: 'c' }], 'c', 'right')).toBe('linked')
  })

  test('a topic off to the side is not that way', () => {
    expect(stepFrom([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20, y: 200 }], [], 'a', 'right')).toBe(null)
  })

  test('an unknown topic goes nowhere', () => {
    expect(stepFrom(points, [], 'gone', 'right')).toBe(null)
  })
})
