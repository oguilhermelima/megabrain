import { describe, expect, test } from 'bun:test'
import type { NativeChat, ProjectSession } from '@/api/schema'
import type { MenuItem } from '@/components/ContextMenu'
import type { AppTerminal } from '@/terminal/terminal-list'
import { chatMenu, joinLabel, middleClickAction, sessionMenu, terminalMenu, withSplitItems, type RowMenuActions } from '@/advanced/item-menus'

const session = (extra: Partial<ProjectSession> = {}): ProjectSession => ({
  agent: 'claude',
  sessionId: 'claude:1',
  title: 'Claude',
  status: 'idle',
  startedAt: '2026-10-15T10:00:00.000Z',
  lastActivityAt: '2026-10-15T10:00:00.000Z',
  dispatchId: null,
  ...extra,
})

const owned = (extra: Partial<ProjectSession> = {}) => session({ owner: 'megabrain', tmuxServer: 'megabrain-app', tmuxSession: 'claude-1', ...extra })

const chat = (state: NativeChat['state']): NativeChat => ({
  id: 'chat-1',
  agent: 'claude',
  model: null,
  cwd: '/work/repo',
  title: 'teste teste',
  state,
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  lastActivityAt: '2026-10-15T10:00:00.000Z',
})

const terminal = (status: AppTerminal['status']): AppTerminal => ({
  id: 'term-1',
  launch: { kind: 'terminal', engine: 'native', cwd: '/work/repo', firstInput: null, id: 'term-1', title: 'zsh' },
  cwd: '/work/repo',
  engine: 'native',
  name: null,
  program: 'zsh',
  status,
  exitCode: null,
  error: null,
  sessionId: null,
  tmuxSession: null,
  appTerminalId: null,
  pid: null,
})

/** Records which action each item runs, so a test can tell Close from Hide by what it does. */
function recorder() {
  const calls: string[] = []
  const actions: RowMenuActions = {
    close: (row) => calls.push(`close:${row.kind}`),
    hide: (target) => calls.push(`hide:${target.sessionId}`),
    unhide: (target) => calls.push(`unhide:${target.sessionId}`),
    takeOver: (target) => calls.push(`take-over:${target.sessionId}`),
    copy: (text) => calls.push(`copy:${text}`),
    stop: (target) => calls.push(`stop:${target.id}`),
    rename: (target) => calls.push(`rename:${target.id}`),
  }
  return { calls, actions }
}

const labels = (items: MenuItem[]) => items.map((item) => item.label)
const danger = (items: MenuItem[]) => items.filter((item) => item.group === 'danger')
const run = (items: MenuItem[], label: string) => {
  const item = items.find((entry) => entry.label === label)
  if (item === undefined) throw new Error(`no item ${label} in ${labels(items).join(', ')}`)
  item.onSelect()
}

describe('every sidebar item row can be closed from its menu', () => {
  const kinds: [string, (actions: RowMenuActions) => MenuItem[]][] = [
    ['an idle chat', (actions) => chatMenu(chat('idle'), actions)],
    ['a working chat', (actions) => chatMenu(chat('working'), actions)],
    ['a stopped chat', (actions) => chatMenu(chat('stopped'), actions)],
    ['a live terminal', (actions) => terminalMenu(terminal('live'), actions)],
    ['an exited terminal', (actions) => terminalMenu(terminal('exited'), actions)],
    ['a session megabrain owns', (actions) => sessionMenu(owned(), actions, false)],
    ['a session started outside megabrain', (actions) => sessionMenu(session(), actions, false)],
    ['an ended outside session', (actions) => sessionMenu(session({ status: 'ended' }), actions, false)],
    ['an outside session with a running timer', (actions) => sessionMenu(session({ status: 'working', cacheExpiresAt: '2026-10-15T11:00:00.000Z' }), actions, false)],
  ]
  for (const [name, menu] of kinds) {
    test(`${name} has a destructive item that closes, stops, releases or hides it`, () => {
      const { actions } = recorder()
      const items = danger(menu(actions))
      expect(items.length).toBeGreaterThan(0)
      expect(items.some((item) => /^(Close|Stop|Release|Remove)/.test(item.label))).toBe(true)
    })
  }

  test('a chat offers Close, and Stop while it still runs', () => {
    const { calls, actions } = recorder()
    expect(labels(danger(chatMenu(chat('stopped'), actions)))).toEqual(['Close chat'])
    const running = chatMenu(chat('working'), actions)
    expect(labels(danger(running))).toEqual(['Stop chat…', 'Close chat'])
    run(running, 'Close chat')
    run(running, 'Stop chat…')
    expect(calls).toEqual(['close:native', 'stop:chat-1'])
  })

  test('a terminal renames and closes, asking first only while its process may run', () => {
    const { calls, actions } = recorder()
    expect(labels(terminalMenu(terminal('live'), actions))).toEqual(['Rename…', 'Close terminal…'])
    const exited = terminalMenu(terminal('exited'), actions)
    expect(labels(exited)).toEqual(['Rename…', 'Close terminal'])
    run(exited, 'Close terminal')
    expect(calls).toEqual(['close:terminal'])
  })

  test('a session megabrain owns releases, and copies its id', () => {
    const { calls, actions } = recorder()
    const items = sessionMenu(owned(), actions, false)
    expect(labels(items)).toEqual(['Copy session id', 'Release from megabrain…'])
    run(items, 'Release from megabrain…')
    run(items, 'Copy session id')
    expect(calls).toEqual(['close:session', 'copy:claude:1'])
  })

  test('a session megabrain does not run opens here, copies its id, and closes by leaving the list', () => {
    const { calls, actions } = recorder()
    const items = sessionMenu(session(), actions, false)
    expect(labels(items)).toEqual(['Open here', 'Copy session id', 'Close'])
    run(items, 'Close')
    run(items, 'Open here')
    expect(calls).toEqual(['hide:claude:1', 'take-over:claude:1'])
  })

  test('an agent the app launched whose terminal is gone is ended for real, asking first', () => {
    const { calls, actions } = recorder()
    const items = sessionMenu(session({ owner: 'megabrain', origin: 'megabrain', terminalPid: 54192 }), actions, false)
    expect(labels(items)).toEqual(['Copy session id', 'End session…'])
    run(items, 'End session…')
    expect(calls).toEqual(['close:session'])
  })

  test('a hidden session shown on request offers to come back instead of Close', () => {
    const { calls, actions } = recorder()
    const items = sessionMenu(session(), actions, true)
    expect(labels(items)).toEqual(['Open here', 'Copy session id', 'Keep in the list'])
    run(items, 'Keep in the list')
    expect(calls).toEqual(['unhide:claude:1'])
  })
})

describe('split items sit in their own group', () => {
  const split: MenuItem[] = [
    { label: 'Split right', icon: 'splitRight', group: 'open', onSelect: () => {} },
    { label: 'Split down', icon: 'splitDown', group: 'open', onSelect: () => {} },
  ]

  test('they keep the row items and move the split ones to the split group', () => {
    const { actions } = recorder()
    const items = withSplitItems(sessionMenu(session(), actions, false), split)
    expect(items.filter((item) => item.group === 'split').map((item) => item.label)).toEqual(['Split right', 'Split down'])
    expect(labels(danger(items))).toEqual(['Close'])
    expect(labels(items)).toContain('Open here')
  })

  test('a row without split items keeps its own menu', () => {
    const { actions } = recorder()
    const own = chatMenu(chat('idle'), actions)
    expect(withSplitItems(own, [])).toEqual(own)
  })
})

describe('joinLabel', () => {
  const member = (title: string) => ({ title })

  test('a named group is joined by its name', () => {
    expect(joinLabel({ name: 'Review', members: [member('a'), member('b')] })).toEqual({ label: 'Join with Review', full: 'Join with Review' })
  })

  test('an unnamed group is its first member and how many more', () => {
    const members = ['Teste, nao precisa responder nada', 'New chat', 'teste teste', 'New chat', 'New chat'].map(member)
    const joined = joinLabel({ name: null, members })
    expect(joined.full).toBe('Join with Teste, nao precisa responder nada + New chat + teste teste + New chat + New chat')
    expect(joined.label.length).toBeLessThanOrEqual(40)
    expect(joined.label.startsWith('Join with Teste')).toBe(true)
    expect(joined.label.endsWith(' +4')).toBe(true)
  })

  test('a short first title keeps every character', () => {
    expect(joinLabel({ name: null, members: [member('zsh'), member('Claude')] }).label).toBe('Join with zsh +1')
  })

  test('a lone item is its title', () => {
    expect(joinLabel({ name: null, members: [member('Claude')] }).label).toBe('Join with Claude')
  })

  test('a long name is cut to about 40 characters, with the whole one kept for the tooltip', () => {
    const name = 'A group with a very long name that keeps on going'
    const joined = joinLabel({ name, members: [member('a'), member('b')] })
    expect(joined.label.length).toBeLessThanOrEqual(40)
    expect(joined.label.endsWith('…')).toBe(true)
    expect(joined.full).toBe(`Join with ${name}`)
  })
})

describe('middleClickAction', () => {
  test('a chat or terminal row closes through the same path as its Close item', () => {
    expect(middleClickAction({ kind: 'native', chat: chat('working') })).toEqual({ kind: 'close', row: { kind: 'native', chat: chat('working') } })
    expect(middleClickAction({ kind: 'terminal', terminal: terminal('live') })).toEqual({ kind: 'close', row: { kind: 'terminal', terminal: terminal('live') } })
  })

  test('a session megabrain owns releases, one it does not run leaves the list', () => {
    expect(middleClickAction({ kind: 'session', session: owned() })).toEqual({ kind: 'close', row: { kind: 'session', session: owned() } })
    expect(middleClickAction({ kind: 'session', session: session() })).toEqual({ kind: 'hide', session: session() })
  })

  test('an agent the app launched closes through the same path, not by leaving the list', () => {
    const launched = session({ owner: 'megabrain', origin: 'megabrain', terminalPid: 54192 })
    expect(middleClickAction({ kind: 'session', session: launched })).toEqual({ kind: 'close', row: { kind: 'session', session: launched } })
  })

  test('project, worktree, folder and group rows do nothing', () => {
    for (const kind of ['project', 'worktree', 'folder', 'group'] as const) expect(middleClickAction({ kind })).toBeNull()
  })
})
