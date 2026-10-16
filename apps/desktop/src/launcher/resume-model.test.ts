import { describe, expect, test } from 'bun:test'
import { mockNativeChat } from '@/api/fixtures/chat'
import { mockProjects } from '@/api/fixtures/mock'
import type { HistorySession } from '@/api/schema'
import { alreadyOpen, resumeLaunch, resumePage, resumePageSize, resumeRows } from '@/launcher/resume-model'

const at = (minutesAgo: number) => new Date(Date.parse('2026-10-15T12:00:00.000Z') - minutesAgo * 60_000).toISOString()
const past = (agent: HistorySession['agent'], id: string, title: string, minutesAgo: number, messageCount: number | null = null): HistorySession => ({
  agent,
  id,
  title,
  startedAt: at(minutesAgo + 30),
  lastActivityAt: at(minutesAgo),
  messageCount,
})

const history: HistorySession[] = [
  past('claude', 'c-old', 'Fix the seek bar', 300, 12),
  past('codex', 'x-new', 'Queue cancel owner', 5),
  past('claude', 'c-new', 'Desktop resume list', 1, 40),
  past('grok', 'g-1', 'Probe the leader socket', 60),
  past('agy', 'a-1', 'Seek bar polish', 90),
]

describe('resumeRows', () => {
  test('All agents shows every agent, newest first', () => {
    expect(resumeRows(history, 'all', '').map((row) => row.id)).toEqual(['c-new', 'x-new', 'g-1', 'a-1', 'c-old'])
  })

  test('an agent tile shows only that agent, newest first', () => {
    expect(resumeRows(history, 'claude', '').map((row) => row.id)).toEqual(['c-new', 'c-old'])
    expect(resumeRows(history, 'grok', '').map((row) => row.id)).toEqual(['g-1'])
  })

  test('the terminal tile shows every agent, newest first', () => {
    expect(resumeRows(history, 'terminal', '').map((row) => row.id)).toEqual(['c-new', 'x-new', 'g-1', 'a-1', 'c-old'])
  })

  test('a session with no activity time sorts by when it started, and one with neither goes last', () => {
    const noActivity = { ...past('claude', 'c-started', 'Started only', 0), lastActivityAt: null, startedAt: at(2) }
    const nothing = { ...past('claude', 'c-none', 'No times', 0), lastActivityAt: null, startedAt: null }
    expect(resumeRows([nothing, ...history, noActivity], 'claude', '').map((row) => row.id)).toEqual(['c-new', 'c-started', 'c-old', 'c-none'])
  })

  test('search matches the title ignoring case and surrounding space', () => {
    expect(resumeRows(history, 'terminal', '  SEEK bar ').map((row) => row.id)).toEqual(['a-1', 'c-old'])
  })

  test('search applies after the agent filter', () => {
    expect(resumeRows(history, 'claude', 'seek').map((row) => row.id)).toEqual(['c-old'])
  })

  test('search also finds a session by the start of its id', () => {
    expect(resumeRows(history, 'terminal', 'x-n').map((row) => row.id)).toEqual(['x-new'])
  })

  test('nothing matching is an empty list', () => {
    expect(resumeRows(history, 'codex', 'seek')).toEqual([])
    expect(resumeRows([], 'terminal', '')).toEqual([])
  })
})

describe('resumePage', () => {
  const many = Array.from({ length: 19 }, (_, index) => index)

  test('the first page holds eight rows and counts the rest', () => {
    expect(resumePageSize).toBe(8)
    expect(resumePage(many, 1)).toEqual({ rows: many.slice(0, 8), hidden: 11 })
  })

  test('each Show more adds another eight', () => {
    expect(resumePage(many, 2)).toEqual({ rows: many.slice(0, 16), hidden: 3 })
  })

  test('the last page shows what is left and hides nothing', () => {
    expect(resumePage(many, 3)).toEqual({ rows: many, hidden: 0 })
    expect(resumePage(many, 9)).toEqual({ rows: many, hidden: 0 })
  })

  test('a short list fits on the first page', () => {
    expect(resumePage([1, 2, 3], 1)).toEqual({ rows: [1, 2, 3], hidden: 0 })
  })
})

describe('alreadyOpen', () => {
  test('a session the sidebar lists under the same agent and id opens that one', () => {
    const found = alreadyOpen(past('claude', '5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', 'Desktop app', 0), mockProjects, [])
    expect(found).toMatchObject({ kind: 'session', session: { sessionId: 'claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d' } })
    expect(found?.kind === 'session' ? found.worktreePath : null).toBeTruthy()
  })

  test('a native chat running that agent session opens the chat', () => {
    const found = alreadyOpen(past('claude', mockNativeChat.agentSessionId ?? '', 'Chat', 0), [], [mockNativeChat])
    expect(found).toEqual({ kind: 'native', chat: mockNativeChat })
  })

  test('the same id under another agent is not the same session', () => {
    expect(alreadyOpen(past('codex', '5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', 'x', 0), mockProjects, [])).toBeNull()
    expect(alreadyOpen(past('codex', mockNativeChat.agentSessionId ?? '', 'x', 0), [], [mockNativeChat])).toBeNull()
  })

  test('a session nobody shows is resumed fresh', () => {
    expect(alreadyOpen(past('claude', 'never-seen', 'x', 0), mockProjects, [mockNativeChat])).toBeNull()
  })
})

describe('resumeLaunch', () => {
  const session = past('codex', 'x-new', 'Queue cancel owner', 5)

  test('resumes the agent TUI on tmux in the worktree, with nothing typed', () => {
    expect(resumeLaunch(session, { cwd: '/w', tile: 'codex', model: 'gpt-6-luna', effort: 'high' })).toEqual({
      kind: 'agent-terminal',
      agent: 'codex',
      engine: 'tmux',
      cwd: '/w',
      model: 'gpt-6-luna',
      effort: 'high',
      firstInput: null,
      resume: 'x-new',
    })
  })

  test('the model picked for another tile is not passed to this agent', () => {
    expect(resumeLaunch(session, { cwd: '/w', tile: 'terminal', model: 'opus', effort: 'high' })).toMatchObject({ model: null, effort: null })
    expect(resumeLaunch(session, { cwd: '/w', tile: 'claude', model: 'opus', effort: 'high' })).toMatchObject({ model: null, effort: null })
  })
})
