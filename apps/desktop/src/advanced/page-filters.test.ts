import { describe, expect, test } from 'bun:test'
import type { Artifact, KnowledgeTopicSummary } from '@/api/schema'
import { groupArtifacts } from '@/advanced/artifacts-model'
import { artifactFilterOptions, emptyArtifactFilters, emptyTopicFilters, filterArtifacts, filterTopics, noChat } from '@/advanced/page-filters'

const now = Date.parse('2026-10-18T12:00:00Z')
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()

const topic = (fields: Partial<KnowledgeTopicSummary> & Pick<KnowledgeTopicSummary, 'id'>): KnowledgeTopicSummary => ({
  project: '/repo', title: fields.id, kind: 'feat', status: 'active', createdAt: daysAgo(40), updatedAt: daysAgo(1), aliases: [], overview: '', chats: [], refs: [], activity: 1, ...fields,
})

const artifact = (fields: Partial<Artifact> & Pick<Artifact, 'id'>): Artifact => ({
  title: fields.id, kind: 'doc', format: 'markdown', project: '/repo', projectName: 'repo', projectId: 'repo', topics: [], chatId: null, createdAt: daysAgo(40), updatedAt: daysAgo(1), revision: 1, path: `/state/${fields.id}.md`, ...fields,
})

const ids = (items: { id: string }[]) => items.map((item) => item.id)

describe('filterTopics', () => {
  const topics = [
    topic({ id: 'pager', kind: 'feat', refs: [{ kind: 'pr', id: '12' }] }),
    topic({ id: 'crash', kind: 'fix', status: 'shipped', updatedAt: daysAgo(20), refs: [{ kind: 'commit', id: 'abc1234' }] }),
    topic({ id: 'idea', kind: 'investigation', status: 'dropped', updatedAt: daysAgo(200) }),
  ]

  test('no filter keeps every topic', () => {
    expect(ids(filterTopics(topics, emptyTopicFilters, now))).toEqual(['pager', 'crash', 'idea'])
  })

  test('kind, status and updated within narrow together', () => {
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, kind: 'fix' }, now))).toEqual(['crash'])
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, status: 'dropped' }, now))).toEqual(['idea'])
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, updated: '30' }, now))).toEqual(['pager', 'crash'])
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, updated: '7', kind: 'fix' }, now))).toEqual([])
  })

  test('linked work tells GitHub links from commits from nothing', () => {
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, link: 'github' }, now))).toEqual(['pager'])
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, link: 'commit' }, now))).toEqual(['crash'])
    expect(ids(filterTopics(topics, { ...emptyTopicFilters, link: 'none' }, now))).toEqual(['idea'])
  })
})

describe('filterArtifacts', () => {
  const [project] = groupArtifacts([
    artifact({ id: 'map', kind: 'diagram', format: 'html', topics: ['t1'], chatId: 'chat-a' }),
    artifact({ id: 'plan', kind: 'plan', topics: ['t1', 't2'], chatId: 'chat-b', updatedAt: daysAgo(60) }),
    artifact({ id: 'notes', kind: 'doc' }),
  ])
  if (project === undefined) throw new Error('no project')
  const shown = (filters: Partial<typeof emptyArtifactFilters>) => ids(filterArtifacts(project, { ...emptyArtifactFilters, ...filters }, now).kinds.flatMap((group) => group.artifacts))

  test('each filter narrows, and kinds left empty drop out', () => {
    expect(shown({})).toEqual(['map', 'plan', 'notes'])
    expect(shown({ kind: 'plan' })).toEqual(['plan'])
    expect(filterArtifacts(project, { ...emptyArtifactFilters, kind: 'plan' }, now).kinds.map((group) => group.kind)).toEqual(['plan'])
    expect(shown({ format: 'html' })).toEqual(['map'])
    expect(shown({ topic: 't2' })).toEqual(['plan'])
    expect(shown({ updated: '30' })).toEqual(['map', 'notes'])
  })

  test('the chat filter picks one chat, or the artifacts no chat filed', () => {
    expect(shown({ chat: 'chat-a' })).toEqual(['map'])
    expect(shown({ chat: noChat })).toEqual(['notes'])
  })

  test('the sheet offers the topics and chats the artifacts name, once each', () => {
    expect(artifactFilterOptions(project)).toEqual({ topics: ['t1', 't2'], chats: ['chat-a', 'chat-b'] })
  })
})
