import type { AppTerminalListing } from '@/api/adapter'
import type { TerminalEngine } from '@/api/schema'
import type { LaunchPlan } from '@/launcher/launch-model'
import { pendingError } from '@/lib/pending-model'

// The terminals the app opened in this run: a plain shell from the launcher, the worktree menu or
// ⌘T, or an agent's own TUI. Each is its own sidebar item under the worktree that holds its folder.
// A native terminal lives for the app run. A tmux one outlives it: on the next start megabrain's CLI
// lists the sessions the app left on its tmux server, and they come back under their worktree.

/** A terminal the launcher, the worktree menu or ⌘T asked for, before it opens. */
export type TerminalLaunch = Exclude<LaunchPlan, { kind: 'chat' }> & { id: string; title: string }

export interface AppTerminal {
  id: string
  launch: TerminalLaunch
  cwd: string
  /** null until a plain terminal starts on the engine the settings choose. */
  engine: TerminalEngine | null
  /** The name the person gave it; null shows the program. */
  name: string | null
  /** The program running in it: the shell's name, or the agent launch's title. */
  program: string
  /** starting shows in its pane at once; failed holds the error until a retry. */
  status: 'starting' | 'live' | 'exited' | 'failed'
  exitCode: number | null
  error: string | null
  /** The embedded terminal's id once it opened. */
  sessionId: string | null
  tmuxSession: string | null
  /** The id megabrain's app terminal list knows it by, for a session the app created on its tmux server. */
  appTerminalId: string | null
}

export function addTerminal(list: AppTerminal[], launch: TerminalLaunch): AppTerminal[] {
  if (list.some((item) => item.id === launch.id)) return list
  const program = launch.kind === 'agent-terminal' ? launch.title : 'shell'
  return [...list, { id: launch.id, launch, cwd: launch.cwd, engine: launch.engine, name: null, program, status: 'starting', exitCode: null, error: null, sessionId: null, tmuxSession: null, appTerminalId: null }]
}

function update(list: AppTerminal[], id: string, change: (item: AppTerminal) => AppTerminal): AppTerminal[] {
  const index = list.findIndex((item) => item.id === id)
  if (index === -1) return list
  const current = list[index] as AppTerminal
  const next = change(current)
  return next === current ? list : list.map((item, at) => (at === index ? next : item))
}

/** It opened: tmux attaches with the tmux client, so a plain shell there is still called a shell. */
export function terminalStarted(list: AppTerminal[], id: string, session: { id: string; title: string; tmuxSession: string | null; engine?: TerminalEngine }): AppTerminal[] {
  return update(list, id, (item) => {
    if (item.status === 'exited') return item
    const program = item.launch.kind === 'agent-terminal' || session.title === 'tmux' ? item.program : session.title
    return { ...item, status: 'live', error: null, sessionId: session.id, tmuxSession: session.tmuxSession, appTerminalId: appTerminalIdOf(session.tmuxSession) ?? item.appTerminalId, program, engine: session.engine ?? item.engine }
  })
}

/** It could not open; the pane shows the error with a retry. One that already went live is not undone. */
export function terminalFailed(list: AppTerminal[], id: string, error: unknown): AppTerminal[] {
  return update(list, id, (item) => (item.status === 'starting' ? { ...item, status: 'failed', error: pendingError(error) } : item))
}

export function terminalRetried(list: AppTerminal[], id: string): AppTerminal[] {
  return update(list, id, (item) => (item.status === 'failed' ? { ...item, status: 'starting', error: null } : item))
}

/** A terminal in this folder is still starting: the trigger that opens one waits for it. */
export function terminalStartingIn(list: readonly AppTerminal[], cwd: string): boolean {
  return list.some((item) => item.cwd === cwd && item.status === 'starting')
}

export function terminalExited(list: AppTerminal[], id: string, code: number | null): AppTerminal[] {
  return update(list, id, (item) => ({ ...item, status: 'exited', exitCode: code }))
}

/** A blank name goes back to the program's. */
export function renameTerminal(list: AppTerminal[], id: string, name: string): AppTerminal[] {
  const trimmed = name.trim()
  return update(list, id, (item) => ({ ...item, name: trimmed === '' ? null : trimmed }))
}

export function removeTerminal(list: AppTerminal[], id: string): AppTerminal[] {
  return list.filter((item) => item.id !== id)
}

export function terminalLabel(terminal: AppTerminal): string {
  return terminal.name ?? terminal.program
}

/** Closing a terminal that may still run a process asks first. */
export function closeNeedsConfirm(terminal: AppTerminal): boolean {
  return terminal.status === 'starting' || terminal.status === 'live'
}

/** Terminals by the deepest worktree that holds their folder, in the order they were opened. */
export function terminalsByWorktree(list: readonly AppTerminal[], worktreePaths: readonly string[]): Record<string, AppTerminal[]> {
  const grouped: Record<string, AppTerminal[]> = {}
  for (const terminal of list) {
    let owner: string | null = null
    for (const path of worktreePaths) {
      const holds = terminal.cwd === path || terminal.cwd.startsWith(path.endsWith('/') ? path : `${path}/`)
      if (holds && (owner === null || path.length > owner.length)) owner = path
    }
    if (owner !== null) (grouped[owner] ??= []).push(terminal)
  }
  return grouped
}

// The app's tmux server and its session names; the Tauri side (terminal.rs) creates them.
const appServer = 'megabrain-app'
const appSessionPrefix = 'mb-app-'

/** The app terminal id behind a tmux session, `mb-app-<id>` or `megabrain-app:mb-app-<id>`; null for any other. */
export function appTerminalIdOf(tmuxSession: string | null): string | null {
  if (tmuxSession === null) return null
  const colon = tmuxSession.indexOf(':')
  if (colon !== -1 && tmuxSession.slice(0, colon) !== appServer) return null
  const session = tmuxSession.slice(colon + 1)
  return session.startsWith(appSessionPrefix) && session.length > appSessionPrefix.length ? session.slice(appSessionPrefix.length) : null
}

/**
 * The tmux terminals a past run left, added after the ones this run holds. A live session comes back
 * unattached until shown; one whose session is gone comes back exited so it can be closed. Each keeps
 * the item id `ids` remembers for it, so a restored layout finds it.
 */
export function restoreAppTerminals(list: AppTerminal[], listings: readonly AppTerminalListing[], ids: Readonly<Record<string, string>>): AppTerminal[] {
  const held = new Set(list.map((item) => item.appTerminalId).filter((id) => id !== null))
  const itemOf = new Map(Object.entries(ids).map(([item, appId]) => [appId, item]))
  const restored = listings
    .filter((listing) => !held.has(listing.id))
    .map((listing): AppTerminal => {
      const id = itemOf.get(listing.id) ?? `terminal-${listing.id}`
      return {
        id,
        launch: { kind: 'terminal', engine: 'tmux', cwd: listing.cwd, firstInput: null, id, title: 'Terminal' },
        cwd: listing.cwd,
        engine: 'tmux',
        name: null,
        program: listing.title === 'tmux' ? 'shell' : listing.title,
        status: listing.alive ? 'live' : 'exited',
        exitCode: null,
        error: null,
        sessionId: null,
        tmuxSession: `${appServer}:${listing.sessionName}`,
        appTerminalId: listing.id,
      }
    })
  return restored.length === 0 ? list : [...list, ...restored]
}

/** Each item's app terminal id, remembered so the next start gives a restored terminal its item back. */
export function terminalSessionIds(list: readonly AppTerminal[]): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const item of list) if (item.appTerminalId !== null) ids[item.id] = item.appTerminalId
  return ids
}

/** A restored layout keeps a terminal's pane only while the terminal can still run. */
export function keepsPane(list: readonly AppTerminal[], id: string): boolean {
  return list.some((item) => item.id === id && item.status !== 'exited')
}

/** Restored and not yet attached: it attaches when a pane shows it, not on launch. */
function unattachedRestore(terminal: AppTerminal): boolean {
  return terminal.appTerminalId !== null && terminal.sessionId === null
}

/** Every terminal stays mounted so it keeps running, except a restored one no pane has shown yet. */
export function mountsInBackground(terminal: AppTerminal): boolean {
  return !unattachedRestore(terminal)
}

/** A restored terminal whose session ended before this run: there is nothing to attach to. */
export function restoredGone(terminal: AppTerminal): boolean {
  return unattachedRestore(terminal) && terminal.status === 'exited'
}

/**
 * How closing reaches the terminal: through the session this run opened, or, for a session the app
 * no longer holds open, by its app terminal id with kill, which also forgets its record.
 */
export function closeCall(terminal: AppTerminal): { id: string; kill: boolean } | null {
  if (terminal.sessionId !== null && terminal.status !== 'exited') return { id: terminal.sessionId, kill: false }
  if (terminal.appTerminalId !== null) return { id: terminal.appTerminalId, kill: true }
  return null
}
