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

const owned = (extra: Partial<ProjectSession> = {}) => session({ owner: 'megabrain', origin: 'megabrain', conversationOwner: 'app-terminal', tmuxServer: 'megabrain-app', tmuxSession: 'mb-claude-1', ...extra })
const ofChat = (extra: Partial<ProjectSession> = {}) => session({ owner: 'megabrain', origin: 'megabrain', conversationOwner: 'app-chat', chatId: 'chat-1', ...extra })

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
    ['a terminal conversation of ours', (actions) => sessionMenu(owned(), actions)],
    ['an ended terminal conversation of ours', (actions) => sessionMenu(owned({ status: 'ended', tmuxServer: null, tmuxSession: null }), actions)],
    ['a chat conversation of ours listed without its chat', (actions) => sessionMenu(ofChat(), actions)],
  ]
  for (const [name, menu] of kinds) {
    test(`${name} has a destructive item that closes, stops, releases or hides it`, () => {
      const { actions } = recorder()
      const items = danger(menu(actions))
      expect(items.length).toBeGreaterThan(0)
      expect(items.some((item) => /^(Close|Stop|Remove)/.test(item.label))).toBe(true)
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

  test('each owner has exactly one Close and no Release, Open here or hide', () => {
    const { calls, actions } = recorder()
    for (const target of [owned(), owned({ status: 'ended', tmuxServer: null, tmuxSession: null }), ofChat(), owned({ terminalPid: 54192, tmuxServer: null, tmuxSession: null })]) {
      const items = sessionMenu(target, actions)
      expect(labels(danger(items))).toHaveLength(1)
      expect(labels(danger(items))[0]).toMatch(/^Close/)
      expect(labels(items).some((label) => /Release|Open here|Keep in the list|End session/.test(label))).toBe(false)
    }
    run(sessionMenu(owned(), actions), 'Close…')
    run(sessionMenu(owned({ status: 'ended', tmuxServer: null, tmuxSession: null }), actions), 'Close')
    expect(calls).toEqual(['close:session', 'close:session'])
  })

  test('a running conversation asks first, an ended one closes at once, both copy their id', () => {
    const { calls, actions } = recorder()
    expect(labels(sessionMenu(owned(), actions))).toEqual(['Copy session id', 'Close…'])
    const ended = sessionMenu(owned({ status: 'ended' }), actions)
    expect(labels(ended)).toEqual(['Copy session id', 'Close'])
    run(ended, 'Copy session id')
    expect(calls).toEqual(['copy:claude:1'])
  })
})

describe('split items sit in their own group', () => {
  const split: MenuItem[] = [
    { label: 'Split right', icon: 'splitRight', group: 'open', onSelect: () => {} },
    { label: 'Split down', icon: 'splitDown', group: 'open', onSelect: () => {} },
  ]

  test('they keep the row items and move the split ones to the split group', () => {
    const { actions } = recorder()
    const items = withSplitItems(sessionMenu(owned({ status: 'ended' }), actions), split)
    expect(items.filter((item) => item.group === 'split').map((item) => item.label)).toEqual(['Split right', 'Split down'])
    expect(labels(danger(items))).toEqual(['Close'])
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

  test('a conversation row of ours closes through the same path as its Close item', () => {
    for (const target of [owned(), ofChat(), owned({ status: 'ended', tmuxServer: null, tmuxSession: null })])
      expect(middleClickAction({ kind: 'session', session: target })).toEqual({ kind: 'close', row: { kind: 'session', session: target } })
  })

  test('project, worktree, folder and group rows do nothing', () => {
    for (const kind of ['project', 'worktree', 'folder', 'group'] as const) expect(middleClickAction({ kind })).toBeNull()
  })
})
