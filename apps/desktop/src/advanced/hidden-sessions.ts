import type { ProjectSession } from '@/api/schema'

// Sessions megabrain does not run, closed from the sidebar. The app cannot end them, so Close takes
// them out of the list instead. One stays out until the person shows it again; activity in it never
// brings it back, and a new conversation is a new session id, which was never hidden. Saved through
// `settings set hidden-sessions`.

export interface HiddenSessions {
  version: 1
  /** Session id to its last activity when it was hidden, kept for the record. */
  sessions: Record<string, string | null>
}

export const noHiddenSessions: HiddenSessions = { version: 1, sessions: {} }

export function parseHiddenSessions(raw: unknown): HiddenSessions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return noHiddenSessions
  const { version, sessions } = raw as Record<string, unknown>
  if (version !== 1 || typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return noHiddenSessions
  const kept: Record<string, string | null> = {}
  for (const [id, at] of Object.entries(sessions)) if (typeof at === 'string' || at === null) kept[id] = at
  return { version: 1, sessions: kept }
}

export function saveHiddenSessions(hidden: HiddenSessions): string {
  return JSON.stringify(hidden)
}

export function hideSession(hidden: HiddenSessions, session: ProjectSession): HiddenSessions {
  return { version: 1, sessions: { ...hidden.sessions, [session.sessionId]: session.lastActivityAt } }
}

export function unhideSession(hidden: HiddenSessions, sessionId: string): HiddenSessions {
  if (!(sessionId in hidden.sessions)) return hidden
  const { [sessionId]: _dropped, ...rest } = hidden.sessions
  return { version: 1, sessions: rest }
}

/** Hidden from when it was closed until the person shows it again. */
export function isHidden(hidden: HiddenSessions, session: ProjectSession): boolean {
  return session.sessionId in hidden.sessions
}
