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

/**
 * The one Close a conversation has, by its owner: a chat closes as the chat (stop, kill its tmux alias,
 * delete); a terminal conversation, live or ended, by ending its process or tmux session and dropping
 * its entry. A dispatch worker or another app's session has none. A row from an older CLI, which names
 * no owner, closes as a terminal while megabrain runs it.
 */
export type ConversationClose = { kind: 'chat'; chatId: string } | { kind: 'terminal'; sessionId: string }

export function closeOf(session: ProjectSession): ConversationClose | null {
  const { conversationOwner: owner, chatId } = session
  if (owner === 'app-chat') return typeof chatId === 'string' && chatId !== '' ? { kind: 'chat', chatId } : { kind: 'terminal', sessionId: session.sessionId }
  if (owner === 'app-terminal') return { kind: 'terminal', sessionId: session.sessionId }
  if (owner === undefined && (ownership(session).owned || appLaunched(session))) return { kind: 'terminal', sessionId: session.sessionId }
  return null
}

export function closable(session: ProjectSession): boolean {
  return closeOf(session) !== null
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
