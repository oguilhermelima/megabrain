import { describe, expect, test } from 'bun:test'
import { CLOSED_SHOWN, closedGroups, visibleGraph } from '@/native-chat/orchestration/orchestration-visible'
import type { OrchestrationGraph, OrchestrationNode } from '@/api/schema'

const node = (id: string, parent: string | null, fields: Partial<OrchestrationNode> = {}): OrchestrationNode => ({
  id, kind: parent === null ? 'coordinator' : 'lane', parent, label: id, agent: 'codex', model: null, effort: null, state: 'working',
  startedAt: '2026-10-18T10:00:00Z', endedAt: null, contextPercent: null, last: null, finding: null, unanswered: false, worktree: null, branch: null, commits: null, chatId: null, session: null,
  ...fields,
})

// A closed lane that ended `minute` minutes past ten, so a higher minute is more recent.
const closed = (id: string, minute: number, parent = 'root'): OrchestrationNode =>
  node(id, parent, { state: 'closed', endedAt: `2026-10-18T10:${String(minute).padStart(2, '0')}:00Z` })

const graph = (nodes: OrchestrationNode[], focus = 'root'): OrchestrationGraph => ({ version: 1, focus, root: 'root', nodes, events: [{ at: '2026-10-18T10:00:00Z', node: 'root', direction: 'to-child', type: 'brief', text: 'go' }] })

const ids = (shown: OrchestrationGraph): string[] => shown.nodes.map((entry) => entry.id).sort()

// root, two live lanes, and ten closed ones c0 (oldest) .. c9 (newest).
const big = [node('root', null), node('live', 'root'), node('asking', 'root', { state: 'asking' }), ...Array.from({ length: 10 }, (_, index) => closed(`c${index}`, index))]

describe('visible graph', () => {
  test('a graph with nothing closed is shown whole', () => {
    const nodes = [node('root', null), node('a', 'root'), node('b', 'root', { state: 'failed' })]
    const { graph: shown, hidden } = visibleGraph(graph(nodes))
    expect(ids(shown)).toEqual(['a', 'b', 'root'])
    expect(hidden).toEqual([])
  })

  test('the coordinator, every lane not closed and the five most recent closed lanes', () => {
    expect(CLOSED_SHOWN).toBe(5)
    const { graph: shown, hidden } = visibleGraph(graph(big))
    expect(ids(shown)).toEqual(['asking', 'c5', 'c6', 'c7', 'c8', 'c9', 'live', 'root'])
    expect(hidden.map((entry) => entry.id)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0'])
  })

  test('only closed lanes are hidden: done, failed and stalled lanes stay however many there are', () => {
    const nodes = [node('root', null), ...Array.from({ length: 8 }, (_, index) => node(`d${index}`, 'root', { state: index % 2 === 0 ? 'done' : 'failed', endedAt: '2026-10-18T10:00:00Z' }))]
    expect(visibleGraph(graph(nodes)).hidden).toEqual([])
  })

  test('a closed lane with no end time ranks by when it started', () => {
    const nodes = [node('root', null), ...Array.from({ length: 6 }, (_, index) => closed(`c${index}`, index + 10)), node('early', 'root', { state: 'closed', startedAt: '2026-10-18T09:00:00Z' }), node('late', 'root', { state: 'closed', startedAt: '2026-10-18T11:00:00Z' })]
    const { graph: shown, hidden } = visibleGraph(graph(nodes))
    expect(ids(shown)).toContain('late')
    expect(hidden.map((entry) => entry.id)).toEqual(['c1', 'c0', 'early'])
  })

  test('the focused node and its path show even when closed and old', () => {
    const nodes = [...big, closed('old-parent', 0), closed('old-child', 1, 'old-parent')]
    const { graph: shown, hidden } = visibleGraph(graph(nodes, 'old-child'))
    expect(ids(shown)).toContain('old-child')
    expect(ids(shown)).toContain('old-parent')
    expect(hidden.map((entry) => entry.id)).not.toContain('old-child')
    expect(hidden.map((entry) => entry.id)).not.toContain('old-parent')
  })

  test('a lane still running under an old closed lane keeps that lane, so it is not drawn under the root', () => {
    const nodes = [...big, closed('old', 0), node('nested', 'old')]
    const { graph: shown, hidden } = visibleGraph(graph(nodes))
    expect(ids(shown)).toContain('nested')
    expect(ids(shown)).toContain('old')
    expect(hidden.map((entry) => entry.id)).not.toContain('old')
  })

  test('a closed coordinator is still shown', () => {
    const nodes = [node('root', null, { state: 'closed', endedAt: '2026-10-18T09:00:00Z' }), ...Array.from({ length: 6 }, (_, index) => closed(`c${index}`, index + 10))]
    expect(ids(visibleGraph(graph(nodes)).graph)).toContain('root')
  })

  test('focus, root and the log stay as the contract gave them', () => {
    const whole = graph(big, 'live')
    const { graph: shown } = visibleGraph(whole)
    expect(shown.focus).toBe('live')
    expect(shown.root).toBe('root')
    expect(shown.events).toBe(whole.events)
  })

  test('at the real size, 317 nodes with 308 closed, the tree draws 14', () => {
    const nodes = [node('root', null), ...Array.from({ length: 8 }, (_, index) => node(`live${index}`, 'root')), ...Array.from({ length: 308 }, (_, index) => node(`c${index}`, 'root', { state: 'closed', endedAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString() }))]
    const { graph: shown, hidden } = visibleGraph(graph(nodes))
    expect(shown.nodes).toHaveLength(14)
    expect(hidden).toHaveLength(303)
  })
})

describe('closed groups', () => {
  test('hidden lanes group under their parent, groups in the order of the tree, newest first in each', () => {
    const nodes = [node('root', null), node('a', 'root', { startedAt: '2026-10-18T10:01:00Z' }), ...Array.from({ length: 5 }, (_, index) => closed(`keep${index}`, 50 + index)), closed('r1', 1), closed('r2', 2), closed('a1', 3, 'a'), closed('a2', 4, 'a')]
    const whole = graph(nodes)
    const groups = closedGroups(whole, visibleGraph(whole).hidden)
    expect(groups.map((group) => ({ parent: group.parent?.id ?? null, nodes: group.nodes.map((entry) => entry.id) }))).toEqual([
      { parent: 'root', nodes: ['r2', 'r1'] },
      { parent: 'a', nodes: ['a2', 'a1'] },
    ])
  })

  test('nothing hidden, no groups', () => {
    expect(closedGroups(graph(big), [])).toEqual([])
  })
})
