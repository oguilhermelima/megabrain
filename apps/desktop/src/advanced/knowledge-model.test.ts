import { describe, expect, test } from 'bun:test'
import type { KnowledgeChat, KnowledgeDecision, KnowledgeTopicSummary } from '@/api/schema'
import { chatCards, decisionsOf, groupTopics, knowledgeItem, knowledgeItemIn, knowledgeView, nodeRadius, refLabel, refNumber, searchTopics, settleTopicSearch, shownTopicSearch, topicGraph } from '@/advanced/knowledge-model'

const topic = (id: string, updatedAt: string, extra: Partial<KnowledgeTopicSummary> = {}): KnowledgeTopicSummary => ({
  id,
  project: '/work/canto',
  title: `topic ${id}`,
  kind: 'feat',
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt,
  aliases: [],
  overview: 'what it is',
  chats: [],
  refs: [],
  activity: 1,
  ...extra,
})

const decision = (id: string, at: string, extra: Partial<KnowledgeDecision> = {}): KnowledgeDecision => ({ id, text: `decision ${id}`, why: `because ${id}`, at, chatId: 'chat-1', ...extra })

const chat = (id: string, startedAt: string, extra: Partial<KnowledgeChat> = {}): KnowledgeChat => ({
  id,
  title: `chat ${id}`,
  summary: 'In this session the player seek was fixed.',
  agent: 'claude',
  model: 'claude-opus-5-5',
  branch: 'main',
  worktree: '/work/canto',
  startedAt,
  endedAt: null,
  topics: [],
  refs: [],
  lastMessages: [],
  ...extra,
})

describe('groupTopics', () => {
  test('groups by kind in the fixed order Features, Fixes, Refactors, Decisions, Investigations, leaving out empty kinds', () => {
    const grouped = groupTopics([
      topic('i', '2026-10-16T10:00:00.000Z', { kind: 'investigation' }),
      topic('f', '2026-10-16T10:00:00.000Z', { kind: 'fix' }),
      topic('a', '2026-10-16T10:00:00.000Z', { kind: 'feat' }),
      topic('d', '2026-10-16T10:00:00.000Z', { kind: 'decision' }),
    ])
    expect(grouped.map((group) => [group.kind, group.label, group.topics.map((entry) => entry.id)])).toEqual([
      ['feat', 'Features', ['a']],
      ['fix', 'Fixes', ['f']],
      ['decision', 'Decisions', ['d']],
      ['investigation', 'Investigations', ['i']],
    ])
  })

  test('each group lists its topics by last update, newest first', () => {
    const grouped = groupTopics([topic('old', '2026-10-10T10:00:00.000Z'), topic('new', '2026-10-16T10:00:00.000Z'), topic('mid', '2026-10-12T10:00:00.000Z')])
    expect(grouped[0]?.topics.map((entry) => entry.id)).toEqual(['new', 'mid', 'old'])
  })

  test('nothing to group is no groups', () => {
    expect(groupTopics([])).toEqual([])
  })
})

describe('searchTopics', () => {
  const topics = [
    topic('summaries', '2026-10-16T10:00:00.000Z', { title: 'Chat summaries', aliases: ['Summaries wiki'], overview: 'Each chat is summarised as it goes.' }),
    topic('seek', '2026-10-15T10:00:00.000Z', { kind: 'fix', title: 'Player seek', overview: 'Seeking keeps the playback rate.', refs: [{ kind: 'pr', id: '412', title: 'Keep rate on seek' }] }),
  ]

  test('matches the title, an alias, the overview and a ref, ignoring case', () => {
    expect(searchTopics(topics, 'CHAT').map((entry) => entry.id)).toEqual(['summaries'])
    expect(searchTopics(topics, 'wiki').map((entry) => entry.id)).toEqual(['summaries'])
    expect(searchTopics(topics, 'playback').map((entry) => entry.id)).toEqual(['seek'])
    expect(searchTopics(topics, '412').map((entry) => entry.id)).toEqual(['seek'])
  })

  test('every word must match, and the best match comes first', () => {
    expect(searchTopics(topics, 'seek rate').map((entry) => entry.id)).toEqual(['seek'])
    expect(searchTopics(topics, 'seek summaries')).toEqual([])
    const both = [topic('one', '2026-10-16T10:00:00.000Z', { title: 'Other', overview: 'mentions seek once' }), topics[1] as KnowledgeTopicSummary]
    expect(searchTopics(both, 'seek').map((entry) => entry.id)).toEqual(['seek', 'one'])
  })

  test('blank text matches nothing', () => {
    expect(searchTopics(topics, '   ')).toEqual([])
  })
})

describe('decisionsOf', () => {
  test('live decisions in the order they were taken; superseded ones apart, each with the decision that replaced it', () => {
    const decisions = [decision('b', '2026-10-12T10:00:00.000Z'), decision('a', '2026-10-10T10:00:00.000Z', { supersededBy: 'c' }), decision('c', '2026-10-14T10:00:00.000Z')]
    const { live, superseded } = decisionsOf(decisions)
    expect(live.map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(superseded.map((entry) => [entry.decision.id, entry.by?.id ?? null])).toEqual([['a', 'c']])
  })

  test('a decision superseded by one that is not listed stays superseded, with no replacement shown', () => {
    const { live, superseded } = decisionsOf([decision('a', '2026-10-10T10:00:00.000Z', { supersededBy: 'gone' })])
    expect(live).toEqual([])
    expect(superseded.map((entry) => [entry.decision.id, entry.by])).toEqual([['a', null]])
  })

  test('a null supersededBy is a live decision', () => {
    expect(decisionsOf([decision('a', '2026-10-10T10:00:00.000Z', { supersededBy: null })]).live.map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('chatCards', () => {
  test("a dispatch worker's chat sits under its parent's card, not as a card of its own", () => {
    const cards = chatCards([chat('parent', '2026-10-16T10:00:00.000Z'), chat('worker-2', '2026-10-16T10:20:00.000Z', { parent: 'parent' }), chat('worker-1', '2026-10-16T10:10:00.000Z', { parent: 'parent' })])
    expect(cards.map((card) => [card.chat.id, card.workers.map((worker) => worker.id)])).toEqual([['parent', ['worker-1', 'worker-2']]])
  })

  test('cards newest first; a worker whose parent is not on the topic is a card of its own', () => {
    const cards = chatCards([chat('old', '2026-10-10T10:00:00.000Z'), chat('orphan', '2026-10-12T10:00:00.000Z', { parent: 'elsewhere' }), chat('new', '2026-10-16T10:00:00.000Z')])
    expect(cards.map((card) => card.chat.id)).toEqual(['new', 'orphan', 'old'])
  })

  test('a worker of a worker sits under the top card', () => {
    const cards = chatCards([chat('top', '2026-10-16T10:00:00.000Z'), chat('mid', '2026-10-16T10:05:00.000Z', { parent: 'top' }), chat('leaf', '2026-10-16T10:06:00.000Z', { parent: 'mid' })])
    expect(cards.map((card) => [card.chat.id, card.workers.map((worker) => worker.id)])).toEqual([['top', ['mid', 'leaf']]])
  })
})

describe('topicGraph', () => {
  test('one node per topic, carrying its kind and activity', () => {
    const graph = topicGraph([topic('a', '2026-10-16T10:00:00.000Z', { kind: 'fix', activity: 7 })])
    expect(graph.nodes).toEqual([{ id: 'a', title: 'topic a', kind: 'fix', status: 'active', activity: 7 }])
    expect(graph.edges).toEqual([])
  })

  test('an edge joins topics that share a chat, a file or another ref, counting each', () => {
    const graph = topicGraph([
      topic('a', '2026-10-16T10:00:00.000Z', { chats: ['c1', 'c2'], refs: [{ kind: 'file', id: 'src/chat/daemon.ts' }, { kind: 'pr', id: '412' }] }),
      topic('b', '2026-10-16T10:00:00.000Z', { chats: ['c2'], refs: [{ kind: 'file', id: 'src/chat/daemon.ts' }] }),
      topic('c', '2026-10-16T10:00:00.000Z', { refs: [{ kind: 'pr', id: '412' }] }),
      topic('d', '2026-10-16T10:00:00.000Z', { chats: ['c9'], refs: [{ kind: 'issue', id: '412' }] }),
    ])
    expect(graph.edges).toEqual([
      { source: 'a', target: 'b', chats: 1, files: 1, refs: 0 },
      { source: 'a', target: 'c', chats: 0, files: 0, refs: 1 },
    ])
  })

  test('the same ref twice in one topic counts once', () => {
    const graph = topicGraph([topic('a', '2026-10-16T10:00:00.000Z', { chats: ['c1', 'c1'] }), topic('b', '2026-10-16T10:00:00.000Z', { chats: ['c1'] })])
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', chats: 1, files: 0, refs: 0 }])
  })
})

describe('nodeRadius', () => {
  test('grows with activity, within bounds', () => {
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(4))
    expect(nodeRadius(4)).toBeLessThan(nodeRadius(40))
    expect(nodeRadius(0)).toBeGreaterThan(0)
    expect(nodeRadius(100_000)).toBe(nodeRadius(1_000_000))
  })
})

describe('refs', () => {
  test('a ref reads as people write it', () => {
    expect(refLabel({ kind: 'issue', id: '87' })).toBe('#87')
    expect(refLabel({ kind: 'pr', id: '#412' })).toBe('PR #412')
    expect(refLabel({ kind: 'commit', id: '05931b886b9b569ad2a0389b5b428e5bc4a6ed36' })).toBe('05931b8')
    expect(refLabel({ kind: 'branch', id: 'feat/knowledge-app' })).toBe('feat/knowledge-app')
    expect(refLabel({ kind: 'file', id: 'apps/desktop/src/advanced/Sidebar.tsx' })).toBe('Sidebar.tsx')
  })

  test("an issue or pull request's number, with or without its #; none for anything else", () => {
    expect(refNumber({ kind: 'issue', id: '87' })).toBe(87)
    expect(refNumber({ kind: 'pr', id: '#412' })).toBe(412)
    expect(refNumber({ kind: 'pr', id: 'oguilhermelima/megabrain#412' })).toBe(412)
    expect(refNumber({ kind: 'pr', id: 'abc' })).toBeNull()
    expect(refNumber({ kind: 'commit', id: '123' })).toBeNull()
  })
})

describe('the Knowledge page item', () => {
  test('round trips what the page shows: project, topic, chat and the map', () => {
    const views = [
      { repo: null, topic: null, chat: null, map: false },
      { repo: '/work/canto', topic: null, chat: null, map: false },
      { repo: '/work/canto', topic: 'topic:chat-summaries', chat: null, map: false },
      { repo: '/work/canto', topic: 'chat-summaries', chat: 'chat-0001', map: false },
      { repo: '/work/a&b=c', topic: null, chat: null, map: true },
    ]
    for (const view of views) expect(knowledgeView(knowledgeItem(view).slice('knowledge:'.length))).toEqual(view)
  })

  test('with nothing picked it is the home page', () => {
    expect(knowledgeItem({ repo: null, topic: null, chat: null, map: false })).toBe('knowledge:home')
    expect(knowledgeView('home')).toEqual({ repo: null, topic: null, chat: null, map: false })
  })

  test('an id it cannot read opens the home page', () => {
    expect(knowledgeView('sum-0001')).toEqual({ repo: null, topic: null, chat: null, map: false })
    expect(knowledgeView('%%%')).toEqual({ repo: null, topic: null, chat: null, map: false })
  })

  test('the layout holds one Knowledge page, an old Summaries page counting as one', () => {
    expect(knowledgeItemIn(['native:a', 'knowledge:home', 'terminal:t'])).toBe('knowledge:home')
    expect(knowledgeItemIn(['native:a', 'summary:sum-0002'])).toBe('summary:sum-0002')
    expect(knowledgeItemIn(['native:a', 'project:/work/canto'])).toBeNull()
  })
})

describe('topic search answers', () => {
  const found = [{ id: 't1' }]

  test('a search that answers after one failed clears the error', () => {
    const failed = settleTopicSearch(null, { key: 'repo\nauth', ok: false, error: new Error('boom') })
    expect(shownTopicSearch(failed, 'repo\nauth')).toEqual({ results: null, error: new Error('boom') })
    const answered = settleTopicSearch(failed, { key: 'repo\nauth', ok: true, results: found })
    expect(shownTopicSearch(answered, 'repo\nauth')).toEqual({ results: found, error: null })
  })

  test('an error or results for other text are not shown for the text typed now', () => {
    const failed = settleTopicSearch(null, { key: 'repo\nauth', ok: false, error: new Error('boom') })
    expect(shownTopicSearch(failed, 'repo\nlogin')).toEqual({ results: null, error: null })
    const answered = settleTopicSearch(null, { key: 'repo\nauth', ok: true, results: found })
    expect(shownTopicSearch(answered, 'repo\nlogin')).toEqual({ results: null, error: null })
  })
})
