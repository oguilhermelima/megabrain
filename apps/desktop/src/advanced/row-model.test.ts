import { describe, expect, test } from 'bun:test'
import type { NativeChat, ProjectSession } from '@/api/schema'
import type { AppTerminal } from '@/terminal/terminal-list'
import { applyRowOrder, endedRows, moveRow, parseRowOrder, rowKey, rowToOpen, saveRowOrder, worktreeItems, type RowOrder } from '@/advanced/row-model'

const session = (sessionId: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  agent: 'claude',
  sessionId,
  title: sessionId,
  status: 'idle',
  startedAt: '2026-10-15T10:00:00.000Z',
  lastActivityAt: '2026-10-15T10:00:00.000Z',
  dispatchId: null,
  ...extra,
})

const chat = (id: string, agent: string, agentSessionId: string | null): NativeChat => ({
  id,
  agent,
  model: null,
  cwd: '/work/repo',
  title: 'teste teste',
  state: 'idle',
  mode: 'chat',
  agentSessionId,
  createdAt: '2026-10-15T10:00:00.000Z',
  lastActivityAt: '2026-10-15T10:00:00.000Z',
})

const terminal = (id: string, resume?: { agent: 'claude' | 'codex'; id: string }): AppTerminal => ({
  id,
  launch:
    resume === undefined
      ? { kind: 'terminal', engine: 'native', cwd: '/work/repo', firstInput: null, id, title: 'zsh' }
      : { kind: 'agent-terminal', agent: resume.agent, engine: 'tmux', cwd: '/work/repo', model: null, effort: null, firstInput: null, resume: resume.id, id, title: 'resume' },
  cwd: '/work/repo',
  engine: resume === undefined ? 'native' : 'tmux',
  name: null,
  program: 'zsh',
  status: 'live',
  exitCode: null,
  error: null,
  sessionId: null,
  tmuxSession: null,
  appTerminalId: null,
  pid: null,
})

const keys = (rows: { key: string }[]) => rows.map((row) => row.key)

describe('worktreeItems', () => {
  test('lists a native Claude chat once, absorbing the session chatd started for it', () => {
    const own = session('claude:17c0244f', { idleCompactAt: '2026-10-15T11:00:00.000Z' })
    const rows = worktreeItems([chat('c1', 'claude', '17c0244f')], [], [own, session('claude:other')])
    expect(keys(rows)).toEqual(['chat:c1', 'session:claude:other'])
    expect(rows[0]).toMatchObject({ kind: 'native', session: own })
  })

  test('lists a native Codex chat once, absorbing its thread', () => {
    const thread = session('codex:thread-9', { agent: 'codex' })
    const rows = worktreeItems([chat('c2', 'codex', 'thread-9')], [], [thread])
    expect(keys(rows)).toEqual(['chat:c2'])
    expect(rows[0]).toMatchObject({ kind: 'native', session: thread })
  })

  test('matches a session id given without its agent prefix too', () => {
    expect(keys(worktreeItems([chat('c1', 'claude', 'abc')], [], [session('abc')]))).toEqual(['chat:c1'])
  })

  test('does not absorb a session of another agent with the same raw id', () => {
    expect(keys(worktreeItems([chat('c1', 'codex', 'abc')], [], [session('claude:abc')]))).toEqual(['chat:c1', 'session:claude:abc'])
  })

  test('a chat whose agent session is not known yet absorbs nothing', () => {
    const rows = worktreeItems([chat('c1', 'claude', null)], [], [session('claude:x')])
    expect(keys(rows)).toEqual(['chat:c1', 'session:claude:x'])
    expect(rows[0]).toMatchObject({ kind: 'native', session: null })
  })

  test('a terminal resumed from Resume absorbs the session it runs', () => {
    const resumed = session('claude:r1')
    const rows = worktreeItems([], [terminal('t1', { agent: 'claude', id: 'r1' }), terminal('t2')], [resumed])
    expect(keys(rows)).toEqual(['terminal:t1', 'terminal:t2'])
    expect(rows[0]).toMatchObject({ kind: 'terminal', session: resumed })
    expect(rows[1]).toMatchObject({ kind: 'terminal', session: null })
  })

  test('an agent the app launched in a native terminal folds into that terminal by its process', () => {
    const launched = session('claude:6e69d457-6446-4efa-b65f-01d6987cc048', { owner: 'megabrain', origin: 'megabrain', terminalPid: 54192 })
    const own = { ...terminal('t1'), pid: 54192 }
    const rows = worktreeItems([], [own, { ...terminal('t2'), pid: 60000 }], [launched])
    expect(keys(rows)).toEqual(['terminal:t1', 'terminal:t2'])
    expect(rows[0]).toMatchObject({ kind: 'terminal', session: launched })
  })

  test('an agent the app launched in a tmux terminal folds into that terminal by its tmux session', () => {
    const launched = session('claude:a1', { owner: 'megabrain', origin: 'megabrain', tmuxServer: 'megabrain-app', tmuxSession: 'mb-app-term-7' })
    const own = { ...terminal('t1'), engine: 'tmux' as const, tmuxSession: 'megabrain-app:mb-app-term-7', appTerminalId: 'term-7' }
    const rows = worktreeItems([], [own], [launched])
    expect(keys(rows)).toEqual(['terminal:t1'])
    expect(rows[0]).toMatchObject({ kind: 'terminal', session: launched })
  })

  test('an app agent whose terminal is gone keeps its own row, so it can be ended', () => {
    const orphan = session('claude:o1', { owner: 'megabrain', origin: 'megabrain', terminalPid: 54192 })
    expect(keys(worktreeItems([], [{ ...terminal('t1'), pid: 1234 }], [orphan]))).toEqual(['terminal:t1', 'session:claude:o1'])
  })

  test('keeps the default order: chats, terminals, then live sessions before ended ones', () => {
    const rows = worktreeItems([chat('c1', 'claude', null)], [terminal('t1')], [session('claude:ended', { status: 'ended' }), session('claude:live')])
    expect(keys(rows)).toEqual(['chat:c1', 'terminal:t1', 'session:claude:live', 'session:claude:ended'])
  })
})

describe('one row per conversation from the projects rows', () => {
  test('a chat claims its conversation by chat id before the agent reported its session to the chat record', () => {
    const own = session('claude:s1', { conversationOwner: 'app-chat', chatId: 'c1' })
    const rows = worktreeItems([chat('c1', 'claude', null)], [], [own])
    expect(keys(rows)).toEqual(['chat:c1'])
    expect(rows[0]).toMatchObject({ kind: 'native', session: own })
  })

  test('a chat, its terminal-mode TUI and its log are one row', () => {
    const own = session('claude:s1', { conversationOwner: 'app-chat', chatId: 'c1', tmuxServer: 'megabrain-app', tmuxSession: 'mb-app-tui' })
    expect(keys(worktreeItems([{ ...chat('c1', 'claude', 's1'), mode: 'terminal' }], [], [own]))).toEqual(['chat:c1'])
  })

  test('a terminal conversation folds into the terminal that runs it', () => {
    const own = session('claude:t', { conversationOwner: 'app-terminal', tmuxServer: 'megabrain-app', tmuxSession: 'mb-app-term-7' })
    const open = { ...terminal('t1'), engine: 'tmux' as const, tmuxSession: 'megabrain-app:mb-app-term-7', appTerminalId: 'term-7' }
    expect(keys(worktreeItems([], [open], [own]))).toEqual(['terminal:t1'])
  })

  test('an ended terminal conversation of ours keeps its own row, so it can be resumed', () => {
    const ended = session('claude:t', { conversationOwner: 'app-terminal', status: 'ended' })
    expect(keys(worktreeItems([], [], [ended]))).toEqual(['session:claude:t'])
  })

  test('a dispatch lane gets a row under its worktree; sessions from other apps get none', () => {
    const rows = worktreeItems([], [], [
      session('claude:worker', { conversationOwner: 'dispatch', dispatchId: 'dispatch-1', origin: 'megabrain', parent: 'claude:coordinator' }),
      session('claude:orca', { conversationOwner: 'foreign', origin: 'external', owner: 'external' }),
      session('codex:ours', { agent: 'codex', conversationOwner: 'app-terminal' }),
    ])
    expect(keys(rows).sort()).toEqual(['session:claude:worker', 'session:codex:ours'])
    expect(rows.find((row) => row.key === 'session:claude:worker')).toMatchObject({ kind: 'session', session: { dispatchId: 'dispatch-1' } })
  })

  test('a lane listed twice, by session id or by dispatch id, gets one row', () => {
    const lane = session('claude:worker', { conversationOwner: 'dispatch', dispatchId: 'dispatch-1' })
    const rows = worktreeItems([], [], [lane, { ...lane }, session('claude:worker-2', { conversationOwner: 'dispatch', dispatchId: 'dispatch-1' })])
    expect(keys(rows)).toEqual(['session:claude:worker'])
  })
})

describe('endedRows', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z')
  const days = (count: number) => new Date(now - count * 86_400_000).toISOString()

  test('conversations that ended more than 7 days ago go under Ended, in their order', () => {
    const rows = worktreeItems(
      [{ ...chat('old-chat', 'claude', null), state: 'suspended', lastActivityAt: days(9) }, { ...chat('new-chat', 'claude', null), state: 'suspended', lastActivityAt: days(2) }],
      [],
      [session('claude:old', { conversationOwner: 'app-terminal', status: 'ended', lastActivityAt: days(30) }), session('claude:recent', { conversationOwner: 'app-terminal', status: 'ended', lastActivityAt: days(6) })],
    )
    const split = endedRows(rows, now)
    expect(keys(split.shown)).toEqual(['chat:new-chat', 'session:claude:recent'])
    expect(keys(split.ended)).toEqual(['chat:old-chat', 'session:claude:old'])
  })

  test('anything still running stays in the list however old its last activity', () => {
    const rows = worktreeItems(
      [{ ...chat('working', 'claude', null), state: 'working', lastActivityAt: days(20) }, { ...chat('idle', 'claude', null), state: 'idle', lastActivityAt: days(20) }],
      [{ ...terminal('t1') }],
      [session('claude:live', { conversationOwner: 'app-terminal', status: 'idle', lastActivityAt: days(20) })],
    )
    expect(endedRows(rows, now).ended).toEqual([])
  })

  test('a row with no activity at all is not old', () => {
    const rows = worktreeItems([{ ...chat('c', 'claude', null), state: 'suspended', lastActivityAt: null, createdAt: days(1) }], [], [])
    expect(endedRows(rows, now).ended).toEqual([])
  })
})

describe('rowKey', () => {
  test('names each kind apart', () => {
    expect(rowKey({ kind: 'native', chat: chat('a', 'claude', null), session: null })).toBe('chat:a')
    expect(rowKey({ kind: 'terminal', terminal: terminal('a'), session: null })).toBe('terminal:a')
    expect(rowKey({ kind: 'session', session: session('claude:a') })).toBe('session:claude:a')
  })
})

describe('applyRowOrder', () => {
  const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]

  test('without a saved order keeps the default order', () => {
    expect(keys(applyRowOrder(rows, []))).toEqual(['a', 'b', 'c'])
  })

  test('follows the saved order', () => {
    expect(keys(applyRowOrder(rows, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  test('puts items the order does not know yet on top, in their default order', () => {
    expect(keys(applyRowOrder([{ key: 'new1' }, ...rows, { key: 'new2' }], ['c', 'a', 'b']))).toEqual(['new1', 'new2', 'c', 'a', 'b'])
  })

  test('ignores saved ids that are gone', () => {
    expect(keys(applyRowOrder(rows, ['gone', 'b', 'stale', 'a']))).toEqual(['c', 'b', 'a'])
  })
})

describe('moveRow', () => {
  test('moves a row before or after another, from the order on screen', () => {
    expect(moveRow(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveRow(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
  })

  test('a drop on itself changes nothing', () => {
    expect(moveRow(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b'])
  })
})

describe('row order persistence', () => {
  test('round trips the order of each worktree', () => {
    const order: RowOrder = { '/work/repo': ['chat:c1', 'terminal:t1'], '/work/other': ['session:claude:x'] }
    expect(parseRowOrder(saveRowOrder(order))).toEqual(order)
  })

  test('starts empty from nothing, bad JSON, another version or the wrong shape', () => {
    expect(parseRowOrder(null)).toEqual({})
    expect(parseRowOrder('not json')).toEqual({})
    expect(parseRowOrder(JSON.stringify({ version: 2, worktrees: { '/a': ['x'] } }))).toEqual({})
    expect(parseRowOrder(JSON.stringify(['x']))).toEqual({})
  })

  test('keeps only the string ids of each worktree', () => {
    expect(parseRowOrder(JSON.stringify({ version: 1, worktrees: { '/a': ['x', 3, null, 'y'], '/b': 'nope' } }))).toEqual({ '/a': ['x', 'y'] })
  })
})

describe('rowToOpen', () => {
  test('a worktree with nothing in it opens nothing, so its launcher opens instead', () => {
    expect(rowToOpen([])).toBeNull()
  })

  test('the most recently active row opens, whatever its kind', () => {
    const older = { ...chat('c1', 'claude', null), lastActivityAt: '2026-10-15T09:00:00.000Z' }
    const newer = session('claude:new', { lastActivityAt: '2026-10-15T12:00:00.000Z' })
    expect(rowToOpen(worktreeItems([older], [], [newer]))?.key).toBe('session:claude:new')
  })

  test('a terminal counts by its session, and a row with no activity loses to one with some', () => {
    const resumed = session('claude:r1', { lastActivityAt: '2026-10-15T13:00:00.000Z' })
    const rows = worktreeItems([], [terminal('t1'), terminal('t2', { agent: 'claude', id: 'r1' })], [resumed])
    expect(rowToOpen(rows)?.key).toBe('terminal:t2')
  })

  test('with no activity anywhere the top row opens', () => {
    expect(rowToOpen(worktreeItems([], [terminal('t1'), terminal('t2')], []))?.key).toBe('terminal:t1')
  })
})
