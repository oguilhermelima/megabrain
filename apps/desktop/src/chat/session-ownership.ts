import type { ProjectSession } from '@/api/schema'

/**
 * A session megabrain owns runs in a tmux session on megabrain's own server (`session own`), so
 * the app attaches to it and the CLI pastes into it. Any other session the app lists was started by
 * megabrain without one (a native chat, a dispatch), so it has no terminal to show.
 */
export type Ownership = { owned: true; tmuxServer: string; tmuxSession: string } | { owned: false }

export function ownership(session: ProjectSession): Ownership {
  const { owner, tmuxServer, tmuxSession } = session
  if (owner !== 'megabrain' || tmuxServer === undefined || tmuxServer === null || tmuxServer === '' || tmuxSession === undefined || tmuxSession === null || tmuxSession === '') return { owned: false }
  return { owned: true, tmuxServer, tmuxSession }
}

/** The app launched it in a native terminal of its own: it can end the process, with nothing to attach. */
export function appLaunched(session: ProjectSession): boolean {
  return session.owner === 'megabrain' && typeof session.terminalPid === 'number'
}

/** megabrain can end it from the app: it owns its tmux session, or the app launched it. */
export function closable(session: ProjectSession): boolean {
  return ownership(session).owned || appLaunched(session)
}

/** The tmux engine's server:session target for the embedded terminal. */
export function ownedTerminalTarget(session: ProjectSession): string | null {
  const owned = ownership(session)
  return owned.owned ? `${owned.tmuxServer}:${owned.tmuxSession}` : null
}

export type SessionViewMode = 'chat' | 'terminal'

/** Only an owned session has a terminal to show; anything else stays on the chat. */
export function sessionView(session: ProjectSession, chosen: SessionViewMode): SessionViewMode {
  return ownership(session).owned ? chosen : 'chat'
}
