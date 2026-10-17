import { describe, expect, test } from 'bun:test'
import type { Artifact } from '@/api/schema'
import { artifactFrameCsp, artifactFrameDocument, artifactOfItem, artifactsForTopic, artifactsItem, artifactsItemIn, groupArtifacts, newestArtifact } from '@/advanced/artifacts-model'
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
