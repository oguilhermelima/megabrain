import type { ProjectSession } from '@/api/schema'

// Opening a session whose agent has not written its log yet (a TUI just launched): the CLI has no
// conversation to read, so the view shows the session's live state and where it runs instead of an
// error.

/** The CLI's answer for a session with no log yet; any other failure is a real error. */
export function isMissingLog(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes('session log unavailable for ')
}

export interface NoLogState {
  activity: string
  note: string
  /** terminal switches to the terminal that runs it; open-here resumes it in megabrain's tmux (`session own`). */
  action: 'terminal' | 'open-here' | null
}

const activities: Record<ProjectSession['status'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle', ended: 'Ended' }

/** `hasTerminal`: an app terminal item runs it. */
export function noLogState(session: ProjectSession, hasTerminal: boolean): NoLogState {
  const activity = activities[session.status]
  const ended = session.status === 'ended'
  if (session.owner === 'megabrain') {
    const attachable = typeof session.tmuxSession === 'string' && session.tmuxSession !== ''
    return { activity, note: 'Nothing is recorded in this conversation yet.', action: !ended && (hasTerminal || attachable) ? 'terminal' : null }
  }
  if (ended) return { activity, note: 'Nothing is recorded in this conversation.', action: null }
  const ownable = session.agent === 'claude' || session.agent === 'codex'
  return { activity, note: 'This session runs in another terminal.', action: ownable ? 'open-here' : null }
}
