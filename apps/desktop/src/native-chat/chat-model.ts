import type { ChatApproval, ChatEventLine, NativeChat, ProjectSession, TranscriptEvent } from '@/api/schema'

// Pure logic for native chats: folding the lines of megabrain chat events into what the view shows,
// which approval waits for an answer, when the conversation may move to the terminal, and where
// each chat sits in the sidebar.

export interface FollowState {
  chat: NativeChat | null
  /** The last cursor applied; the subscription resumes after it. */
  cursor: string | null
  events: TranscriptEvent[]
  /** Approvals by the id of the event that carried them. */
  approvals: Record<string, ChatApproval>
  /** Approval ids this view answered; the chat record may lag behind the answer. */
  answered: string[]
}

export function followState(chat: NativeChat | null): FollowState {
  return { chat, cursor: null, events: [], approvals: {}, answered: [] }
}

const numeric = /^\d+$/

/** Cursors made of digits compare as numbers, whatever their length; any other cursor as text. */
export function compareCursors(a: string, b: string): number {
  if (numeric.test(a) && numeric.test(b)) {
    const left = a.replace(/^0+(?=\d)/, '')
    const right = b.replace(/^0+(?=\d)/, '')
    if (left.length !== right.length) return left.length - right.length
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Folds one line into the state. A line at or before the cursor is a replay (a resubscription from
 * an older cursor) and returns the same state; an event id already shown is not added again.
 */
export function applyLine(state: FollowState, line: ChatEventLine): FollowState {
  if (state.cursor !== null && compareCursors(line.cursor, state.cursor) <= 0) return state
  const next: FollowState = { ...state, cursor: line.cursor }
  if (line.chat !== undefined) next.chat = line.chat
  const event = line.event
  if (event !== undefined && !state.events.some((known) => known.id === event.id)) {
    next.events = state.events.concat(event)
    if (line.approval !== undefined) next.approvals = { ...state.approvals, [event.id]: line.approval }
  }
  return next
}

export function markAnswered(state: FollowState, approvalId: string): FollowState {
  if (state.answered.includes(approvalId)) return state
  return { ...state, answered: state.answered.concat(approvalId) }
}

/** The newest approval not yet answered, while the chat waits for one. */
export function pendingApproval(state: FollowState): ChatApproval | null {
  if (state.chat !== null && state.chat.state !== 'waiting-approval') return null
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index]
    const approval = event === undefined ? undefined : state.approvals[event.id]
    if (approval !== undefined && !state.answered.includes(approval.id)) return approval
  }
  return null
}

export interface ModeToggle {
  target: NativeChat['mode']
  enabled: boolean
  /** Why the toggle is off, for its tooltip. */
  reason: string | null
}

const busyReason: Record<NativeChat['state'], string | null> = {
  idle: null,
  working: 'Wait until the agent finishes its turn',
  'waiting-approval': 'Answer the pending approval first',
  starting: 'The chat is still starting',
  stopped: 'The chat has stopped',
  error: 'The chat stopped on an error',
}

/** The conversation moves to the terminal only while the agent is idle; it can always come back. */
export function modeToggle(chat: NativeChat): ModeToggle {
  if (chat.mode === 'terminal') return { target: 'chat', enabled: true, reason: null }
  const reason = busyReason[chat.state]
  return { target: 'terminal', enabled: reason === null, reason }
}

/** Esc in an empty composer stops the agent's turn. */
export function shouldInterrupt(key: string, text: string, state: NativeChat['state']): boolean {
  return key === 'Escape' && text.trim() === '' && state === 'working'
}

const newestFirst = (a: NativeChat, b: NativeChat) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)

/** Each chat under the deepest worktree that holds its folder; chats outside every worktree are left out. */
export function chatsByWorktree(chats: NativeChat[], worktreePaths: string[]): Record<string, NativeChat[]> {
  const grouped: Record<string, NativeChat[]> = {}
  for (const chat of chats) {
    let owner: string | null = null
    for (const path of worktreePaths) {
      const holds = chat.cwd === path || chat.cwd.startsWith(path.endsWith('/') ? path : `${path}/`)
      if (holds && (owner === null || path.length > owner.length)) owner = path
    }
    if (owner !== null) (grouped[owner] ??= []).push(chat)
  }
  for (const list of Object.values(grouped)) list.sort(newestFirst)
  return grouped
}

/** The sidebar dot a chat state shows, shared with agent sessions. */
export function rowStatus(state: NativeChat['state']): ProjectSession['status'] {
  if (state === 'working' || state === 'starting') return 'working'
  if (state === 'waiting-approval') return 'waiting'
  if (state === 'idle') return 'idle'
  return 'ended'
}

/** The context the composer shows: what the chat reports, or nothing when it reports neither. */
export function composerContext(chat: NativeChat): { tokens: number | null; window: number | null } | undefined {
  const tokens = chat.contextTokens ?? null
  const window = chat.contextWindow ?? null
  return tokens === null && window === null ? undefined : { tokens, window }
}

/** The followed record after a model switch, starting from the listed one before the first line. */
export function withModel(state: FollowState, listed: NativeChat, model: string): FollowState {
  return { ...state, chat: { ...(state.chat ?? listed), model } }
}
