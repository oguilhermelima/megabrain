import { describe, expect, test } from 'bun:test'
import type { AppTerminalListing } from '@/api/adapter'
import {
  addTerminal,
  appTerminalIdOf,
  closeCall,
  closeNeedsConfirm,
  keepsPane,
  mountsInBackground,
  restoreAppTerminals,
  terminalSessionIds,
  removeTerminal,
  renameTerminal,
  terminalExited,
  terminalFailed,
  terminalLabel,
  terminalRetried,
  terminalStartingIn,
  terminalStarted,
  terminalsByWorktree,
  type AppTerminal,
  type TerminalLaunch,
} from '@/terminal/terminal-list'

const shell = (id: string, cwd = '/work/repo'): TerminalLaunch => ({ kind: 'terminal', engine: 'native', cwd, firstInput: null, id, title: 'Terminal' })
const agent = (id: string): TerminalLaunch => ({ kind: 'agent-terminal', agent: 'grok', engine: 'tmux', cwd: '/work/repo', model: null, effort: null, firstInput: null, id, title: 'Grok · fix the build' })

const only = (list: AppTerminal[], id: string) => {
  const found = list.find((item) => item.id === id)
  if (found === undefined) throw new Error(`no terminal ${id}`)
  return found
}

describe('addTerminal', () => {
  test('a new terminal is starting, unnamed, with no session yet', () => {
    const [terminal] = addTerminal([], shell('t1'))
    expect(terminal).toMatchObject({ id: 't1', cwd: '/work/repo', engine: 'native', name: null, status: 'starting', exitCode: null, sessionId: null })
  })

  test('a plain terminal is labelled as a shell until it starts', () => {
    expect(terminalLabel(only(addTerminal([], shell('t1')), 't1'))).toBe('shell')
  })

  test('an agent terminal is labelled with its launch title', () => {
    expect(terminalLabel(only(addTerminal([], agent('t2')), 't2'))).toBe('Grok · fix the build')
  })

  test('keeps the order they were opened in, and adding one twice changes nothing', () => {
    const list = addTerminal(addTerminal([], shell('t1')), shell('t2'))
    expect(list.map((item) => item.id)).toEqual(['t1', 't2'])
    expect(addTerminal(list, shell('t1'))).toBe(list)
  })
})

describe('terminalStarted', () => {
  test('goes live with its session and the running program as its label', () => {
    const list = terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'pty-1', title: 'zsh', tmuxSession: null })
    expect(only(list, 't1')).toMatchObject({ status: 'live', sessionId: 'pty-1', tmuxSession: null })
    expect(terminalLabel(only(list, 't1'))).toBe('zsh')
  })

  test('keeps the process the terminal runs, so the agent session it starts can be matched to it', () => {
    const list = terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'pty-1', title: 'claude', tmuxSession: null, pid: 54192 })
    expect(only(list, 't1').pid).toBe(54192)
    expect(only(addTerminal([], shell('t2')), 't2').pid).toBeNull()
  })

  test('a tmux shell is still called a shell, not tmux', () => {
    const list = terminalStarted(addTerminal([], { ...shell('t1'), engine: 'tmux' }), 't1', { id: 'pty-1', title: 'tmux', tmuxSession: 'megabrain-app:mb-app-1' })
    expect(terminalLabel(only(list, 't1'))).toBe('shell')
    expect(only(list, 't1').tmuxSession).toBe('megabrain-app:mb-app-1')
  })

  test('an agent terminal keeps its launch title', () => {
    const list = terminalStarted(addTerminal([], agent('t2')), 't2', { id: 'pty-2', title: 'grok', tmuxSession: 'mb-app-2' })
    expect(terminalLabel(only(list, 't2'))).toBe('Grok · fix the build')
  })

  test('an unknown terminal changes nothing', () => {
    const list = addTerminal([], shell('t1'))
    expect(terminalStarted(list, 'nope', { id: 'pty', title: 'zsh', tmuxSession: null })).toBe(list)
  })
})

describe('terminalExited', () => {
  test('records the exit and its code', () => {
    const list = terminalExited(terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'pty-1', title: 'zsh', tmuxSession: null }), 't1', 130)
    expect(only(list, 't1')).toMatchObject({ status: 'exited', exitCode: 130 })
  })

  test('an exit without a code is still an exit', () => {
    expect(only(terminalExited(addTerminal([], shell('t1')), 't1', null), 't1')).toMatchObject({ status: 'exited', exitCode: null })
  })

  test('a terminal that exited does not come back to life when its session is reported late', () => {
    const exited = terminalExited(addTerminal([], shell('t1')), 't1', 0)
    expect(only(terminalStarted(exited, 't1', { id: 'pty-1', title: 'zsh', tmuxSession: null }), 't1').status).toBe('exited')
  })
})

describe('renameTerminal', () => {
  test('a name replaces the label, trimmed', () => {
    const list = renameTerminal(addTerminal([], shell('t1')), 't1', '  dev server ')
    expect(terminalLabel(only(list, 't1'))).toBe('dev server')
  })

  test('an empty name goes back to the program label', () => {
    const named = renameTerminal(addTerminal([], shell('t1')), 't1', 'dev server')
    expect(terminalLabel(only(renameTerminal(named, 't1', '   '), 't1'))).toBe('shell')
  })
})

describe('removeTerminal', () => {
  test('takes it out of the list', () => {
    const list = addTerminal(addTerminal([], shell('t1')), shell('t2'))
    expect(removeTerminal(list, 't1').map((item) => item.id)).toEqual(['t2'])
  })
})

describe('closeNeedsConfirm', () => {
  test('while it starts or runs, closing asks first', () => {
    const list = addTerminal([], shell('t1'))
    expect(closeNeedsConfirm(only(list, 't1'))).toBe(true)
    expect(closeNeedsConfirm(only(terminalStarted(list, 't1', { id: 'p', title: 'zsh', tmuxSession: null }), 't1'))).toBe(true)
  })

  test('once it exited, closing does not ask', () => {
    expect(closeNeedsConfirm(only(terminalExited(addTerminal([], shell('t1')), 't1', 0), 't1'))).toBe(false)
  })
})

describe('terminalsByWorktree', () => {
  test('each terminal goes under the deepest worktree that holds its folder, in open order', () => {
    const list = [shell('t1', '/work/repo'), shell('t2', '/work/repo-wt/feature/src'), shell('t3', '/work/repo/sub'), shell('t4', '/elsewhere')].reduce(addTerminal, [] as AppTerminal[])
    const grouped = terminalsByWorktree(list, ['/work/repo', '/work/repo-wt/feature'])
    expect(Object.fromEntries(Object.entries(grouped).map(([path, items]) => [path, items.map((item) => item.id)]))).toEqual({
      '/work/repo': ['t1', 't3'],
      '/work/repo-wt/feature': ['t2'],
    })
  })
})

describe('a terminal that fails to start', () => {
  test('records the error and is no longer starting', () => {
    const list = terminalFailed(addTerminal([], shell('t1')), 't1', new Error('tmux: server exited'))
    expect(only(list, 't1')).toMatchObject({ status: 'failed', error: 'tmux: server exited' })
  })

  test('retry puts it back to starting with no error', () => {
    const failed = terminalFailed(addTerminal([], shell('t1')), 't1', new Error('x'))
    expect(only(terminalRetried(failed, 't1'), 't1')).toMatchObject({ status: 'starting', error: null })
  })

  test('retry on a terminal that did not fail changes nothing', () => {
    const list = addTerminal([], shell('t1'))
    expect(terminalRetried(list, 't1')).toBe(list)
  })

  test('a failed terminal closes without asking: nothing runs in it', () => {
    expect(closeNeedsConfirm(only(terminalFailed(addTerminal([], shell('t1')), 't1', new Error('x')), 't1'))).toBe(false)
  })

  test('a late failure does not undo a terminal that already went live', () => {
    const live = terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'p', title: 'zsh', tmuxSession: null, engine: 'native' })
    expect(only(terminalFailed(live, 't1', new Error('x')), 't1').status).toBe('live')
  })
})

describe('the engine of a plain terminal', () => {
  test('a terminal opened before the settings answered has no engine until it starts', () => {
    const list = addTerminal([], { kind: 'terminal', engine: null, cwd: '/work/repo', firstInput: null, id: 't1', title: 'Terminal' })
    expect(only(list, 't1').engine).toBeNull()
    expect(only(terminalStarted(list, 't1', { id: 'p', title: 'zsh', tmuxSession: 'mb', engine: 'tmux' }), 't1').engine).toBe('tmux')
  })
})

describe('terminalStartingIn', () => {
  test('true while a terminal in that folder is still starting, so the trigger waits for it', () => {
    const list = addTerminal(addTerminal([], shell('t1', '/work/repo')), shell('t2', '/work/other'))
    expect(terminalStartingIn(list, '/work/repo')).toBe(true)
    expect(terminalStartingIn(terminalStarted(list, 't1', { id: 'p', title: 'zsh', tmuxSession: null, engine: 'native' }), '/work/repo')).toBe(false)
    expect(terminalStartingIn(terminalFailed(list, 't1', new Error('x')), '/work/repo')).toBe(false)
    expect(terminalStartingIn(list, '/work/none')).toBe(false)
  })
})

const listing = (id: string, cwd: string, alive = true, title = 'tmux'): AppTerminalListing => ({ id, sessionName: `mb-app-${id}`, cwd, title, command: '', alive, createdAt: '2026-10-15T00:00:00.000Z' })

describe('appTerminalIdOf', () => {
  test('a session the app created on its own server is its listing id', () => {
    expect(appTerminalIdOf('mb-app-abc')).toBe('abc')
    expect(appTerminalIdOf('megabrain-app:mb-app-abc')).toBe('abc')
  })

  test('no session, another server or another name is not an app terminal', () => {
    expect(appTerminalIdOf(null)).toBeNull()
    expect(appTerminalIdOf('default:mb-app-abc')).toBeNull()
    expect(appTerminalIdOf('work')).toBeNull()
  })

  test('a tmux terminal that starts records its listing id', () => {
    const list = terminalStarted(addTerminal([], { ...shell('t1'), engine: 'tmux' }), 't1', { id: 'abc', title: 'tmux', tmuxSession: 'mb-app-abc' })
    expect(only(list, 't1').appTerminalId).toBe('abc')
    expect(only(addTerminal([], shell('t2')), 't2').appTerminalId).toBeNull()
  })
})

describe('restoreAppTerminals', () => {
  test('a live session comes back live, unattached, on tmux, as a shell', () => {
    const [terminal] = restoreAppTerminals([], [listing('abc', '/work/repo')], {})
    expect(terminal).toMatchObject({ cwd: '/work/repo', engine: 'tmux', status: 'live', sessionId: null, tmuxSession: 'megabrain-app:mb-app-abc', appTerminalId: 'abc' })
    expect(terminalLabel(terminal as AppTerminal)).toBe('shell')
  })

  test('an agent session keeps its program as the label', () => {
    expect(terminalLabel(restoreAppTerminals([], [listing('abc', '/work/repo', true, 'grok')], {})[0] as AppTerminal)).toBe('grok')
  })

  test('a session that is gone is not restored: its conversation, if any, lists as an ended row instead', () => {
    expect(restoreAppTerminals([], [listing('abc', '/work/repo', false)], {})).toEqual([])
  })

  test("a chat's terminal-mode TUI is the chat's, never a terminal row of its own", () => {
    const list = restoreAppTerminals([], [{ ...listing('tui', '/work/repo'), chatId: 'c1' }, listing('shell', '/work/repo')], {})
    expect(list.map((item) => item.appTerminalId)).toEqual(['shell'])
  })

  test('keeps the item id the layout remembered for that session, else derives one', () => {
    const list = restoreAppTerminals([], [listing('abc', '/work/repo'), listing('def', '/work/repo')], { 'terminal-1': 'abc' })
    expect(list.map((item) => item.id)).toEqual(['terminal-1', 'terminal-def'])
    expect(list[0]?.launch.id).toBe('terminal-1')
  })

  test('a session the app already holds is not listed twice', () => {
    const open = terminalStarted(addTerminal([], { ...shell('t1'), engine: 'tmux' }), 't1', { id: 'abc', title: 'tmux', tmuxSession: 'mb-app-abc' })
    const list = restoreAppTerminals(open, [listing('abc', '/work/repo'), listing('def', '/work/repo')], {})
    expect(list.map((item) => item.id)).toEqual(['t1', 'terminal-def'])
    expect(restoreAppTerminals(list, [listing('def', '/work/repo')], {})).toBe(list)
  })

  test('restored terminals sit under the worktree that holds their folder', () => {
    const list = restoreAppTerminals([], [listing('a', '/work/repo'), listing('b', '/work/repo-wt/feature/src'), listing('c', '/elsewhere')], {})
    const grouped = terminalsByWorktree(list, ['/work/repo', '/work/repo-wt/feature'])
    expect(grouped['/work/repo']?.map((item) => item.appTerminalId)).toEqual(['a'])
    expect(grouped['/work/repo-wt/feature']?.map((item) => item.appTerminalId)).toEqual(['b'])
    expect(Object.keys(grouped)).toHaveLength(2)
  })
})

describe('terminalSessionIds', () => {
  test('maps each item to its app session, skipping terminals that have none', () => {
    const list = restoreAppTerminals(addTerminal([], shell('t1')), [listing('abc', '/work/repo')], { 'terminal-9': 'abc' })
    expect(terminalSessionIds(list)).toEqual({ 'terminal-9': 'abc' })
  })
})

describe('keepsPane', () => {
  test('a restored layout keeps live terminals and drops exited and unknown ones', () => {
    const list = restoreAppTerminals(addTerminal([], shell('t1')), [listing('abc', '/work/repo'), listing('dead', '/work/repo', false)], {})
    expect(keepsPane(list, 't1')).toBe(true)
    expect(keepsPane(list, 'terminal-abc')).toBe(true)
    expect(keepsPane(list, 'terminal-dead')).toBe(false)
    expect(keepsPane(list, 'terminal-missing')).toBe(false)
  })
})

describe('mountsInBackground', () => {
  test('a restored terminal attaches only once it is shown', () => {
    const [restored] = restoreAppTerminals([], [listing('abc', '/work/repo')], {})
    expect(mountsInBackground(restored as AppTerminal)).toBe(false)
    const attached = terminalStarted([restored as AppTerminal], 'terminal-abc', { id: 'pty-2', title: 'tmux', tmuxSession: 'megabrain-app:mb-app-abc' })
    expect(mountsInBackground(only(attached, 'terminal-abc'))).toBe(true)
  })

  test('terminals opened in this run stay mounted', () => {
    expect(mountsInBackground(only(addTerminal([], shell('t1')), 't1'))).toBe(true)
  })

  test('a terminal that is gone is not restored, so there is nothing to mount', () => {
    expect(restoreAppTerminals([], [listing('dead', '/work/repo', false)], {}).filter(mountsInBackground)).toEqual([])
  })
})

describe('closeCall', () => {
  test('an open terminal closes through its session', () => {
    const list = terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'pty-1', title: 'zsh', tmuxSession: null })
    expect(closeCall(only(list, 't1'))).toEqual({ id: 'pty-1', kill: false })
  })

  test('a restored terminal the app does not hold is killed by its listing id', () => {
    const list = restoreAppTerminals([], [listing('abc', '/work/repo'), listing('dead', '/work/repo', false)], {})
    expect(closeCall(only(list, 'terminal-abc'))).toEqual({ id: 'abc', kill: true })
    expect(list.map((item) => item.id)).toEqual(['terminal-abc'])
  })

  test('an exited tmux terminal from this run forgets its session record', () => {
    const started = terminalStarted(addTerminal([], { ...shell('t1'), engine: 'tmux' }), 't1', { id: 'abc', title: 'tmux', tmuxSession: 'mb-app-abc' })
    expect(closeCall(only(terminalExited(started, 't1', 0), 't1'))).toEqual({ id: 'abc', kill: true })
  })

  test('a terminal that never opened has nothing to close', () => {
    expect(closeCall(only(addTerminal([], shell('t1')), 't1'))).toBeNull()
    const exited = terminalExited(terminalStarted(addTerminal([], shell('t1')), 't1', { id: 'pty-1', title: 'zsh', tmuxSession: null }), 't1', 0)
    expect(closeCall(only(exited, 't1'))).toBeNull()
  })
})
