import { describe, expect, test } from 'bun:test'
import type { NativeChat, Project, ProjectScripts, ProjectSession, ProjectWorktree } from '@/api/schema'
import { changeCounts, defaultBranch, heroFacts, newestFirst, recentChats, scriptRows, scriptState, worktreeSummaries } from '@/advanced/project-page-model'
import type { RunTab, WorktreePanel } from '@/run-panel/run-model'

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

  test('counts the chats working now, and keeps the branch apart from the name', () => {
    const busy = { '/work/canto-new': [chat('n1', '/work/canto-new', null, { state: 'working' })] }
    const row = worktreeSummaries(canto, busy).find((entry) => entry.path === '/work/canto-new')
    expect(row?.working).toBe(1)
    expect(row?.branch).toBe('feat/new')
    expect(worktreeSummaries(canto, busy).find((entry) => entry.path === '/work/canto-detached')?.branch).toBeNull()
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

describe('changeCounts', () => {
  const branch = (changes: { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }[]) => ({ base: 'main', mergeBase: 'abc', changes })

  test('counts committed and uncommitted files by kind, each path once', () => {
    const counts = changeCounts(
      [
        { path: 'a.ts', status: 'modified' },
        { path: 'new.ts', status: 'untracked' },
      ],
      branch([
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'added' },
        { path: 'old.ts', status: 'deleted' },
        { path: 'moved.ts', status: 'renamed' },
      ]),
    )
    expect(counts).toEqual({ added: 2, modified: 2, deleted: 1, uncommitted: 2 })
  })

  test('a file the branch added stays added while edited, and is no change once deleted again', () => {
    const counts = changeCounts(
      [
        { path: 'b.ts', status: 'modified' },
        { path: 'c.ts', status: 'deleted' },
      ],
      branch([
        { path: 'b.ts', status: 'added' },
        { path: 'c.ts', status: 'added' },
      ]),
    )
    expect(counts).toEqual({ added: 1, modified: 0, deleted: 0, uncommitted: 2 })
  })

  test('without a base only the uncommitted work counts', () => {
    expect(changeCounts([{ path: 'x', status: 'deleted' }], null)).toEqual({ added: 0, modified: 0, deleted: 1, uncommitted: 1 })
    expect(changeCounts([], null)).toEqual({ added: 0, modified: 0, deleted: 0, uncommitted: 0 })
  })
})

describe('heroFacts', () => {
  test('worktrees, open pull requests and issues, and the chats working now', () => {
    expect(heroFacts({ worktrees: 3, working: 1, pulls: 2, issues: 1 }).map((fact) => fact.text)).toEqual(['3 worktrees', '2 open pull requests', '1 open issue', '1 chat working'])
    expect(heroFacts({ worktrees: 1, working: 2, pulls: 0, issues: 0 }).find((fact) => fact.key === 'working')).toEqual({ key: 'working', text: '2 chats working', live: true })
  })

  test('leaves out what is not read yet or not on GitHub, and an idle project says nothing about chats', () => {
    expect(heroFacts({ worktrees: 1, working: 0, pulls: null, issues: null }).map((fact) => fact.text)).toEqual(['1 worktree'])
  })
})

describe('scriptState', () => {
  const tab = (action: RunTab['action'], status: RunTab['status']): RunTab => ({ action, command: 'x', generation: 1, terminalId: null, status, movedTo: null, conflict: null })
  const panel = (tabs: RunTab[]): WorktreePanel => ({ open: true, tabs, active: null, last: null })

  test('idle until run in the worktree', () => {
    expect(scriptState(null, 'run')).toEqual({ kind: 'idle' })
    expect(scriptState(panel([tab('build', { kind: 'running' })]), 'run')).toEqual({ kind: 'idle' })
  })

  test('starting (or queued) and running while its tab is live', () => {
    expect(scriptState(panel([tab('run', { kind: 'starting' })]), 'run')).toEqual({ kind: 'starting' })
    expect(scriptState(panel([tab('run', { kind: 'running' })]), 'run')).toEqual({ kind: 'running' })
  })

  test('failed on a code other than 0, stopped when stopped or clean', () => {
    expect(scriptState(panel([tab('run', { kind: 'exited', code: 1 })]), 'run')).toEqual({ kind: 'failed', code: 1 })
    expect(scriptState(panel([tab('run', { kind: 'exited', code: 0 })]), 'run')).toEqual({ kind: 'stopped' })
    expect(scriptState(panel([tab('run', { kind: 'exited', code: null })]), 'run')).toEqual({ kind: 'stopped' })
  })
})
