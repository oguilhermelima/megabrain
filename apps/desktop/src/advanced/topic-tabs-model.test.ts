import { describe, expect, test } from 'bun:test'
import type { KnowledgeChat, KnowledgeRef, KnowledgeTopic } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'
import { branchGroups, githubRefGroups, readTopicTab, shownTopicTab, topicTabs, topicTabsKey, writeTopicTab, type TopicTab } from '@/advanced/topic-tabs-model'

const chat = (id: string, branch: string, refs: KnowledgeRef[] = []): KnowledgeChat => ({
  id,
  title: `chat ${id}`,
  summary: 'In this session the player seek was fixed.',
  agent: 'claude',
  model: 'claude-opus-5-5',
  branch,
  worktree: '/work/canto',
  startedAt: '2026-10-01T10:00:00.000Z',
  endedAt: null,
  topics: ['t'],
  refs,
  lastMessages: [],
})

type KeyMessage = KnowledgeTopic['keyMessages'][number]

const message: KeyMessage = { chatId: 'c1', eventCursor: '1', at: '2026-10-01T10:00:00.000Z', role: 'person', text: 'Tests first.', why: 'Set the scope.' }

const empty = { refs: [] as KnowledgeRef[], keyMessages: [] as KeyMessage[], chatRecords: [] as KnowledgeChat[] }

const tabsOf = (topic: typeof empty) => topicTabs(topic).map((entry) => entry.tab)

describe('topicTabs', () => {
  test('a topic with nothing but its sections has only the overview', () => {
    expect(topicTabs(empty)).toEqual([{ tab: 'overview', label: 'Overview', count: null }])
  })

  test('messages show when the topic has key messages or chats', () => {
    expect(tabsOf({ ...empty, keyMessages: [message] })).toEqual(['overview', 'messages'])
    expect(tabsOf({ ...empty, chatRecords: [chat('c1', 'main')] })).toEqual(['overview', 'messages'])
  })

  test('every tab in its fixed order, each counting what it lists', () => {
    const refs: KnowledgeRef[] = [
      { kind: 'file', id: 'src/a.ts' },
      { kind: 'pr', id: '412' },
      { kind: 'branch', id: 'fix/seek' },
      { kind: 'issue', id: '398' },
      { kind: 'commit', id: '9f2c4e1' },
      { kind: 'issue', id: '400' },
      { kind: 'file', id: 'src/b.ts' },
      { kind: 'branch', id: 'feat/x' },
    ]
    expect(topicTabs({ refs, keyMessages: [message], chatRecords: [] })).toEqual([
      { tab: 'overview', label: 'Overview', count: null },
      { tab: 'messages', label: 'Messages', count: null },
      { tab: 'refs', label: 'Issues and PRs', count: 3 },
      { tab: 'branches', label: 'Branches', count: 2 },
      { tab: 'files', label: 'Files', count: 2 },
    ])
  })

  test('commits alone open the branches tab, counted as commits', () => {
    const refs: KnowledgeRef[] = [
      { kind: 'commit', id: 'aaaaaaa' },
      { kind: 'commit', id: 'bbbbbbb' },
    ]
    expect(topicTabs({ ...empty, refs })).toEqual([
      { tab: 'overview', label: 'Overview', count: null },
      { tab: 'branches', label: 'Branches', count: 2 },
    ])
  })

  test('a ref of each kind listed twice counts once', () => {
    const refs: KnowledgeRef[] = [
      { kind: 'pr', id: '412' },
      { kind: 'pr', id: '412', title: 'again' },
    ]
    expect(topicTabs({ ...empty, refs }).find((entry) => entry.tab === 'refs')?.count).toBe(1)
  })
})

describe('shownTopicTab', () => {
  const tabs = topicTabs({ ...empty, keyMessages: [message] })
  test('the chosen tab when the topic has it', () => {
    expect(shownTopicTab(tabs, 'messages')).toBe('messages')
  })

  test('the overview when nothing was chosen or the chosen tab has nothing to show', () => {
    expect(shownTopicTab(tabs, null)).toBe('overview')
    expect(shownTopicTab(tabs, 'branches')).toBe('overview')
  })
})

describe('githubRefGroups', () => {
  const refs: KnowledgeRef[] = [
    { kind: 'issue', id: '398', title: 'Seek resets speed' },
    { kind: 'pr', id: '412', title: 'Keep the rate' },
    { kind: 'pr', id: '371' },
    { kind: 'issue', id: 'operator/canto#405' },
    { kind: 'branch', id: 'fix/seek' },
    { kind: 'commit', id: '9f2c4e1' },
    { kind: 'file', id: 'src/a.ts' },
    { kind: 'pr', id: '420' },
  ]
  const states: Record<string, string | null> = { '398': 'closed', '412': 'merged', '371': 'open', 'operator/canto#405': null, '420': 'draft' }
  const groups = githubRefGroups(refs, (ref) => states[ref.id] ?? null)

  test('only issues and pull requests, each with its kind, number and state', () => {
    const all = [...groups.open, ...groups.closed]
    expect(all.map((row) => row.kind).sort()).toEqual(['issue', 'issue', 'pr', 'pr', 'pr'])
    expect(all.find((row) => row.ref.id === 'operator/canto#405')).toMatchObject({ kind: 'issue', number: 405, state: null })
  })

  test('open first, a draft and an unknown state counting as open; closed and merged after', () => {
    expect(groups.open.map((row) => row.ref.id)).toEqual(['420', 'operator/canto#405', '371'])
    expect(groups.closed.map((row) => row.ref.id)).toEqual(['412', '398'])
  })

  test('newest number first inside each group, a ref without a number last', () => {
    const odd = githubRefGroups(
      [
        { kind: 'issue', id: 'not-a-number' },
        { kind: 'issue', id: '7' },
        { kind: 'pr', id: '9' },
      ],
      () => 'open',
    )
    expect(odd.open.map((row) => row.ref.id)).toEqual(['9', '7', 'not-a-number'])
    expect(odd.closed).toEqual([])
  })

  test('a state is read case-blind', () => {
    const upper = githubRefGroups([{ kind: 'pr', id: '1' }], () => 'MERGED')
    expect(upper.closed.map((row) => row.state)).toEqual(['merged'])
  })
})

describe('branchGroups', () => {
  test('each branch with its state, and the commits a chat on that branch made under it', () => {
    const refs: KnowledgeRef[] = [
      { kind: 'branch', id: 'fix/seek', state: 'MERGED' },
      { kind: 'branch', id: 'feat/old' },
      { kind: 'commit', id: '9f2c4e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f', title: 'fix: restore the rate' },
      { kind: 'commit', id: '1234567890abcdef' },
      { kind: 'pr', id: '412' },
    ]
    // A chat may name a commit by its short sha.
    const chats = [chat('c1', 'fix/seek', [{ kind: 'commit', id: '9f2c4e1' }]), chat('c2', 'main', [{ kind: 'commit', id: '1234567890abcdef' }])]
    const groups = branchGroups({ refs, chatRecords: chats })
    expect(groups.branches.map((branch) => ({ name: branch.ref.id, state: branch.state, commits: branch.commits.map((commit) => commit.id) }))).toEqual([
      { name: 'fix/seek', state: 'merged', commits: ['9f2c4e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f'] },
      { name: 'feat/old', state: null, commits: [] },
    ])
    // main is not one of the topic's branches, so its commit stays on its own.
    expect(groups.commits.map((commit) => commit.id)).toEqual(['1234567890abcdef'])
  })

  test('no branches puts every commit on its own', () => {
    const groups = branchGroups({ refs: [{ kind: 'commit', id: 'aaaaaaa' }], chatRecords: [] })
    expect(groups.branches).toEqual([])
    expect(groups.commits.map((commit) => commit.id)).toEqual(['aaaaaaa'])
  })

  test('a branch or commit listed twice appears once', () => {
    const groups = branchGroups({
      refs: [
        { kind: 'branch', id: 'fix/seek' },
        { kind: 'branch', id: 'fix/seek' },
        { kind: 'commit', id: 'aaaaaaa' },
        { kind: 'commit', id: 'aaaaaaa' },
      ],
      chatRecords: [],
    })
    expect(groups.branches).toHaveLength(1)
    expect(groups.commits).toHaveLength(1)
  })
})

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

describe('topic tab memory', () => {
  test('each topic remembers its own tab', () => {
    const storage = memory()
    expect(writeTopicTab(() => storage, 'a', 'messages')).toBe('messages')
    writeTopicTab(() => storage, 'b', 'refs')
    expect(readTopicTab(() => storage, 'a')).toBe('messages')
    expect(readTopicTab(() => storage, 'b')).toBe('refs')
    expect(readTopicTab(() => storage, 'c')).toBeNull()
    expect(topicTabsKey.startsWith('megabrain.')).toBe(true)
  })

  test('nothing stored, something else stored, or storage that throws remembers nothing', () => {
    expect(readTopicTab(() => memory(), 'a')).toBeNull()
    expect(readTopicTab(() => memory({ [topicTabsKey]: 'not json' }), 'a')).toBeNull()
    expect(readTopicTab(() => memory({ [topicTabsKey]: JSON.stringify({ a: 'nonsense' }) }), 'a')).toBeNull()
    expect(readTopicTab(() => memory({ [topicTabsKey]: JSON.stringify(['messages']) }), '0')).toBeNull()
    expect(readTopicTab(() => throwing, 'a')).toBeNull()
    expect(writeTopicTab(() => throwing, 'a', 'files')).toBe('files')
  })

  test('only the 200 topics picked last are kept', () => {
    const storage = memory()
    for (let n = 0; n < 205; n++) writeTopicTab(() => storage, `t${n}`, 'messages')
    // Picking t5 again makes it the newest, so the next new topic pushes out t6 instead.
    writeTopicTab(() => storage, 't5', 'files')
    writeTopicTab(() => storage, 't205', 'messages')
    expect(readTopicTab(() => storage, 't4')).toBeNull()
    const kept = JSON.parse(storage.values[topicTabsKey] ?? '{}') as Record<string, TopicTab>
    expect(Object.keys(kept)).toHaveLength(200)
    expect(readTopicTab(() => storage, 't6')).toBeNull()
    expect(readTopicTab(() => storage, 't7')).toBe('messages')
    expect(readTopicTab(() => storage, 't5')).toBe('files')
    expect(readTopicTab(() => storage, 't205')).toBe('messages')
  })
})
