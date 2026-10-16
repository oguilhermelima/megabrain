import { describe, expect, test } from 'bun:test'
import type { NativeChat, Project, ProjectScripts, ProjectSession, ProjectWorktree } from '@/api/schema'
import { defaultBranch, newestFirst, recentChats, scriptRows, worktreeSummaries } from '@/advanced/project-page-model'

const session = (sessionId: string, lastActivityAt: string | null, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  agent: 'claude',
  sessionId,
  title: sessionId,
  status: 'idle',
  startedAt: null,
  lastActivityAt,
  dispatchId: null,
  ...extra,
})

const chat = (id: string, cwd: string, lastActivityAt: string | null, extra: Partial<NativeChat> = {}): NativeChat => ({
  id,
  agent: 'codex',
  model: null,
  cwd,
  title: id,
  state: 'idle',
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-16T08:00:00.000Z',
  lastActivityAt,
  ...extra,
})

const worktree = (path: string, branch: string | null, extra: Partial<ProjectWorktree> = {}): ProjectWorktree => ({
  path,
  branch,
  head: 'abcdef1234',
  primary: false,
  parent: null,
  pullRequest: null,
  sessions: [],
  ...extra,
})

const project = (worktrees: ProjectWorktree[]): Project => ({ name: 'canto', path: '/work/canto', remote: 'git@github.com:acme/canto.git', source: 'import', missing: false, worktrees })

describe('worktreeSummaries', () => {
  const canto = project([
    worktree('/work/canto-old', 'feat/old', { sessions: [session('claude:old', '2026-10-10T10:00:00.000Z')] }),
    worktree('/work/canto', 'main', { primary: true }),
    worktree('/work/canto-new', 'feat/new', {
      pullRequest: { number: 12, state: 'OPEN', url: 'https://github.com/acme/canto/pull/12', title: 'New thing', isDraft: true },
      sessions: [session('claude:a', '2026-10-16T09:00:00.000Z')],
    }),
    worktree('/work/canto-hidden', 'feat/hidden', { hidden: true }),
    worktree('/work/canto-detached', null),
  ])
  const chats = { '/work/canto-new': [chat('n1', '/work/canto-new', '2026-10-16T11:00:00.000Z')] }

  test('the main checkout first, then the most recently active, hidden worktrees left out', () => {
    expect(worktreeSummaries(canto, chats).map((row) => row.path)).toEqual(['/work/canto', '/work/canto-new', '/work/canto-old', '/work/canto-detached'])
  })

  test('each names its branch, or its detached commit', () => {
    const rows = worktreeSummaries(canto, chats)
    expect(rows.find((row) => row.path === '/work/canto-new')?.name).toBe('feat/new')
    expect(rows.find((row) => row.path === '/work/canto-detached')?.name).toBe('Detached at abcdef1')
  })

  test('the pull request carries its drawn state', () => {
    const row = worktreeSummaries(canto, chats).find((entry) => entry.path === '/work/canto-new')
    expect(row?.pullRequest).toEqual({ number: 12, state: 'draft', title: 'New thing' })
  })

  test('chats count every chat and session once, and the latest activity is the newest of them', () => {
    const row = worktreeSummaries(canto, chats).find((entry) => entry.path === '/work/canto-new')
    expect(row?.chatCount).toBe(2)
    expect(row?.lastActivityAt).toBe('2026-10-16T11:00:00.000Z')
  })

  test('a chat that runs a listed session counts once', () => {
    const resumed = { '/work/canto-new': [chat('n1', '/work/canto-new', null, { agent: 'claude', agentSessionId: 'a' })] }
    expect(worktreeSummaries(canto, resumed).find((entry) => entry.path === '/work/canto-new')?.chatCount).toBe(1)
  })

  test('a click opens the latest chat, or the launcher in an empty worktree', () => {
    const rows = worktreeSummaries(canto, chats)
    expect(rows.find((row) => row.path === '/work/canto-new')?.open).toMatchObject({ kind: 'native', chat: { id: 'n1' } })
    expect(rows.find((row) => row.path === '/work/canto-old')?.open).toMatchObject({ kind: 'session', session: { sessionId: 'claude:old' } })
    expect(rows.find((row) => row.path === '/work/canto')?.open).toEqual({ kind: 'launcher' })
  })
})

describe('recentChats', () => {
  const canto = project([
    worktree('/work/canto', 'main', { primary: true, sessions: [session('claude:a', '2026-10-16T09:00:00.000Z', { status: 'working' })] }),
    worktree('/work/canto-b', 'feat/b', { sessions: [session('claude:b', null)] }),
  ])
  const chats = { '/work/canto-b': [chat('n1', '/work/canto-b', '2026-10-16T10:00:00.000Z', { title: null })] }

  test('every chat across the project, newest first, never-active last', () => {
    expect(recentChats(canto, chats, 10).map((row) => row.key)).toEqual(['chat:n1', 'session:claude:a', 'session:claude:b'])
  })

  test('each says where it runs, its agent and its state', () => {
    const [first, second] = recentChats(canto, chats, 10)
    expect(first).toMatchObject({ title: 'New chat', agent: 'codex', status: 'idle', worktree: 'feat/b' })
    expect(second).toMatchObject({ title: 'claude:a', agent: 'claude', status: 'working', worktree: 'main' })
  })

  test('stops at the limit', () => {
    expect(recentChats(canto, chats, 1)).toHaveLength(1)
  })
})

describe('newestFirst', () => {
  test('orders by last update and keeps the first few', () => {
    const items = [
      { number: 1, updatedAt: '2026-10-01T00:00:00Z' },
      { number: 2, updatedAt: '2026-10-03T00:00:00Z' },
      { number: 3, updatedAt: '2026-10-02T00:00:00Z' },
    ]
    expect(newestFirst(items, 2).map((item) => item.number)).toEqual([2, 3])
  })
})

describe('scriptRows', () => {
  test('run, build and install with their commands, unset ones null', () => {
    const scripts: ProjectScripts = { repo: '/work/canto', scripts: { run: { command: 'pnpm dev', source: 'saved' }, build: null, install: { command: 'pnpm install', source: 'detected' } } }
    expect(scriptRows(scripts)).toEqual([
      { action: 'run', label: 'Run', command: 'pnpm dev', detected: false },
      { action: 'build', label: 'Build', command: null, detected: false },
      { action: 'install', label: 'Install', command: 'pnpm install', detected: true },
    ])
  })

  test('scripts not read yet are three empty rows', () => {
    expect(scriptRows(null).map((row) => row.command)).toEqual([null, null, null])
  })
})

describe('defaultBranch', () => {
  test("is the main checkout's branch", () => {
    expect(defaultBranch(project([worktree('/w/x', 'feat/x'), worktree('/work/canto', 'main', { primary: true })]))).toBe('main')
  })

  test('is unknown without a main checkout on a branch', () => {
    expect(defaultBranch(project([worktree('/work/canto', null, { primary: true })]))).toBeNull()
  })
})
