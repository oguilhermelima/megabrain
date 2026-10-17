import { describe, expect, test } from 'bun:test'
import type { Artifact, ArtifactContent } from '@/api/schema'
import { artifactFrameCsp, artifactFrameDocument, artifactOfItem, artifactsForTopic, artifactsItem, artifactsItemIn, artifactTabs, artifactTabsKey, filterArtifactProject, groupArtifacts, newestArtifact, readArtifactTab, revisionRows, shownArtifactProject, shownArtifactTab, writeArtifactTab } from '@/advanced/artifacts-model'
import type { WidthStorage } from '@/lib/panel-width'
import { itemKey, parseItem } from '@/panes/pane-model'

const artifact = (id: string, updatedAt: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  title: `artifact ${id}`,
  kind: 'plan',
  format: 'markdown',
  project: '/work/canto',
  projectName: 'canto',
  projectId: 'canto-0123456789ab',
  topics: [],
  chatId: null,
  createdAt: updatedAt,
  updatedAt,
  revision: 1,
  path: `/state/knowledge/canto-0123456789ab/artifacts/${id}/doc.md`,
  ...extra,
})

describe('groupArtifacts', () => {
  test('puts each artifact under its project and kind, kinds in a fixed order', () => {
    const grouped = groupArtifacts([
      artifact('plan', '2026-10-16T10:00:00.000Z'),
      artifact('diagram', '2026-10-16T09:00:00.000Z', { kind: 'diagram', format: 'html' }),
      artifact('doc', '2026-10-16T11:00:00.000Z', { kind: 'doc' }),
      artifact('juntin', '2026-10-15T10:00:00.000Z', { project: '/work/juntin', projectName: 'juntin', projectId: 'juntin-0123456789ab' }),
    ])
    expect(grouped.map((project) => [project.project, project.name, project.kinds.map((group) => [group.kind, group.artifacts.map((entry) => entry.id)])])).toEqual([
      ['/work/canto', 'canto', [['diagram', ['diagram']], ['plan', ['plan']], ['doc', ['doc']]]],
      ['/work/juntin', 'juntin', [['plan', ['juntin']]]],
    ])
  })

  test('orders projects by their latest change and each kind newest first', () => {
    const grouped = groupArtifacts([
      artifact('old', '2026-10-10T10:00:00.000Z'),
      artifact('juntin', '2026-10-15T10:00:00.000Z', { project: '/work/juntin', projectName: 'juntin' }),
      artifact('new', '2026-10-16T10:00:00.000Z'),
    ])
    expect(grouped.map((project) => project.name)).toEqual(['canto', 'juntin'])
    expect(grouped[0]?.kinds[0]?.artifacts.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  test('nothing listed is no project', () => {
    expect(groupArtifacts([])).toEqual([])
    expect(newestArtifact([])).toBeNull()
  })

  test('the newest artifact is the newest of the first project, whatever its kind', () => {
    const grouped = groupArtifacts([artifact('plan', '2026-10-16T10:00:00.000Z'), artifact('doc', '2026-10-16T12:00:00.000Z', { kind: 'doc' }), artifact('diagram', '2026-10-16T11:00:00.000Z', { kind: 'diagram', format: 'html' })])
    expect(newestArtifact(grouped)?.id).toBe('doc')
  })
})

describe('artifactsForTopic', () => {
  test('keeps the artifacts filed under the topic, newest first', () => {
    const list = [artifact('a', '2026-10-01T00:00:00.000Z', { topics: ['t1'] }), artifact('b', '2026-10-02T00:00:00.000Z', { topics: ['t2'] }), artifact('c', '2026-10-03T00:00:00.000Z', { topics: ['t2', 't1'] })]
    expect(artifactsForTopic(list, 't1').map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(artifactsForTopic(list, 'none')).toEqual([])
  })
})

describe('the Artifacts page item', () => {
  test('an artifact id round-trips through the pane key', () => {
    const key = artifactsItem('art-1')
    const parsed = parseItem(key)
    expect(parsed).toEqual({ kind: 'artifact', id: 'art-1' })
    expect(artifactOfItem(parsed?.id ?? '')).toBe('art-1')
  })

  test('the page with nothing picked opens on the newest', () => {
    const parsed = parseItem(artifactsItem(null))
    expect(parsed?.kind).toBe('artifact')
    expect(artifactOfItem(parsed?.id ?? '')).toBeNull()
  })

  test('finds the Artifacts page among a layout items, and only it', () => {
    expect(artifactsItemIn([itemKey('native', 'chat-1'), itemKey('knowledge', 'home'), artifactsItem('art-2')])).toBe(artifactsItem('art-2'))
    expect(artifactsItemIn([itemKey('knowledge', 'home')])).toBeNull()
  })
})

describe('the sandboxed frame document', () => {
  test('the policy blocks scripts and every network fetch', () => {
    expect(artifactFrameCsp).toContain("default-src 'none'")
    expect(artifactFrameCsp).not.toContain('http')
    expect(artifactFrameCsp).not.toContain('script-src')
  })

  test('the policy goes first inside an existing head', () => {
    const html = '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://example.com/a.css"></head><body>x</body></html>'
    const framed = artifactFrameDocument(html)
    const meta = framed.indexOf('http-equiv="Content-Security-Policy"')
    expect(meta).toBeGreaterThan(framed.indexOf('<head>'))
    expect(meta).toBeLessThan(framed.indexOf('<title>'))
  })

  test('a fragment with no head still gets the policy before its content', () => {
    const framed = artifactFrameDocument('<svg viewBox="0 0 1 1"></svg>')
    expect(framed.indexOf('Content-Security-Policy')).toBeGreaterThanOrEqual(0)
    expect(framed.indexOf('Content-Security-Policy')).toBeLessThan(framed.indexOf('<svg'))
  })
})

describe('one project at a time', () => {
  const list = [
    artifact('canto-plan', '2026-10-16T10:00:00.000Z', { title: 'Search rollout' }),
    artifact('canto-diagram', '2026-10-16T12:00:00.000Z', { kind: 'diagram', format: 'html', title: 'Store layout' }),
    artifact('canto-doc', '2026-10-16T11:00:00.000Z', { kind: 'doc', title: 'Offline notes' }),
    artifact('juntin-plan', '2026-10-17T10:00:00.000Z', { project: '/work/juntin', projectName: 'juntin', title: 'Search page' }),
  ]

  test('shows the picked artifact’s project, else the project with the newest change', () => {
    const grouped = groupArtifacts(list)
    expect(shownArtifactProject(grouped, 'canto-doc')?.project).toBe('/work/canto')
    expect(shownArtifactProject(grouped, null)?.project).toBe('/work/juntin')
    expect(shownArtifactProject(grouped, 'gone')?.project).toBe('/work/juntin')
    expect(shownArtifactProject([], null)).toBeNull()
  })

  test('lists the project’s artifacts as Diagrams, Plans and Docs', () => {
    const canto = shownArtifactProject(groupArtifacts(list), 'canto-plan')
    expect(canto?.kinds.map((group) => [group.kind, group.artifacts.map((entry) => entry.id)])).toEqual([
      ['diagram', ['canto-diagram']],
      ['plan', ['canto-plan']],
      ['doc', ['canto-doc']],
    ])
  })

  test('a filter keeps the titles that contain it, in any case, and drops the kinds left empty', () => {
    const canto = shownArtifactProject(groupArtifacts(list), 'canto-plan')
    if (canto === null) throw new Error('no project')
    expect(filterArtifactProject(canto, '  SEARCH ').kinds.map((group) => [group.kind, group.artifacts.map((entry) => entry.id)])).toEqual([['plan', ['canto-plan']]])
    expect(filterArtifactProject(canto, 'nothing like it').kinds).toEqual([])
    expect(filterArtifactProject(canto, '  ')).toEqual(canto)
  })
})

const content = (revision: number, revisions?: ArtifactContent['revisions']): ArtifactContent => ({ ...artifact('art-1', '2026-10-17T12:00:00.000Z', { title: 'Plan v3', revision }), content: '# Plan', ...(revisions === undefined ? {} : { revisions }) })

describe('the artifact’s tabs', () => {
  test('Preview, Details and Source, in that order; Details counts the versions once there is more than one', () => {
    expect(artifactTabs(content(1))).toEqual([
      { tab: 'preview', label: 'Preview', count: null },
      { tab: 'details', label: 'Details', count: null },
      { tab: 'source', label: 'Source', count: null },
    ])
    expect(artifactTabs(content(3)).map((entry) => entry.count)).toEqual([null, 3, null])
  })

  test('shows the tab chosen, else Preview', () => {
    const tabs = artifactTabs(content(1))
    expect(shownArtifactTab(tabs, 'source')).toBe('source')
    expect(shownArtifactTab(tabs, null)).toBe('preview')
  })
})

describe('the remembered tab', () => {
  function memory(initial: Record<string, string> = {}): WidthStorage & { values: Record<string, string> } {
    const values = { ...initial }
    return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) }
  }

  test('each artifact remembers the tab last shown on it', () => {
    const storage = memory()
    expect(readArtifactTab(() => storage, 'art-1')).toBeNull()
    expect(writeArtifactTab(() => storage, 'art-1', 'details')).toBe('details')
    writeArtifactTab(() => storage, 'art-2', 'source')
    expect(readArtifactTab(() => storage, 'art-1')).toBe('details')
    expect(readArtifactTab(() => storage, 'art-2')).toBe('source')
    expect(artifactTabsKey.startsWith('megabrain.')).toBe(true)
  })

  test('the artifacts picked longest ago are forgotten first, past 200', () => {
    const storage = memory()
    for (let index = 0; index < 201; index += 1) writeArtifactTab(() => storage, `art-${index}`, 'details')
    expect(readArtifactTab(() => storage, 'art-0')).toBeNull()
    expect(readArtifactTab(() => storage, 'art-1')).toBe('details')
    expect(readArtifactTab(() => storage, 'art-200')).toBe('details')
  })

  test('storage that is blocked, or holds something else, remembers nothing and breaks nothing', () => {
    const blocked: WidthStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readArtifactTab(() => blocked, 'art-1')).toBeNull()
    expect(writeArtifactTab(() => blocked, 'art-1', 'source')).toBe('source')
    expect(readArtifactTab(() => memory({ [artifactTabsKey]: '{not json' }), 'art-1')).toBeNull()
    expect(readArtifactTab(() => memory({ [artifactTabsKey]: JSON.stringify([['art-1', 'map']]) }), 'art-1')).toBeNull()
  })
})

describe('revisionRows', () => {
  test('the current version first, then the earlier ones newest first, each with when it was written and replaced', () => {
    const rows = revisionRows(
      content(3, [
        { revision: 1, title: 'Plan v1', updatedAt: '2026-10-15T10:00:00.000Z', replacedAt: '2026-10-16T10:00:00.000Z' },
        { revision: 2, title: 'Plan v1', updatedAt: '2026-10-16T10:00:00.000Z', replacedAt: '2026-10-17T12:00:00.000Z' },
      ]),
    )
    expect(rows).toEqual([
      { revision: 3, title: 'Plan v3', at: '2026-10-17T12:00:00.000Z', replacedAt: null, current: true },
      { revision: 2, title: 'Plan v1', at: '2026-10-16T10:00:00.000Z', replacedAt: '2026-10-17T12:00:00.000Z', current: false },
      { revision: 1, title: 'Plan v1', at: '2026-10-15T10:00:00.000Z', replacedAt: '2026-10-16T10:00:00.000Z', current: false },
    ])
  })

  test('a CLI that lists no revisions leaves the current version alone', () => {
    expect(revisionRows(content(2)).map((row) => row.revision)).toEqual([2])
  })
})
