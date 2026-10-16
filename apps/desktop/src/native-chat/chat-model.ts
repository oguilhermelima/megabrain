import type { LiveRow } from '@/chat/conversation-model'
import { nativeChatStateSchema, type ChatApproval, type ChatDeltaEvent, type ChatEventLine, type ChatStateEvent, type NativeChat, type ProjectSession, type TranscriptEvent } from '@/api/schema'

// Pure logic for native chats: folding the lines of megabrain chat events into what the view shows,
// which approval waits for an answer, when the conversation may move to the terminal, and where
// each chat sits in the sidebar. Besides the stored history, the state holds what is still live: the
// messages being streamed (drafts) and the ones this view sent that the chat has not echoed yet.

/** A message being generated, grown from its chunks until the complete event replaces it. */
export interface Draft {
  messageId: string
  stream: ChatDeltaEvent['stream']
  text: string
  /** Arrival order among drafts and outgoing messages. */
  order: number
}

/** A message this view sent, shown at once until the chat's user event confirms it. */
export interface Outgoing {
  id: string
  text: string
  sentAt: string
  order?: number
}

export interface FollowState {
  chat: NativeChat | null
  /** The last cursor applied; the subscription resumes after it. */
  cursor: string | null
  events: TranscriptEvent[]
  /** Approvals by the id of the event that carried them. */
  approvals: Record<string, ChatApproval>
  /** Approval ids this view answered; the chat record may lag behind the answer. */
  answered: string[]
  /** When the running turn started, from the last state event; null outside a turn. */
  turnStartedAt: string | null
  drafts: Draft[]
  /** Message ids whose complete event arrived; a late chunk for one is dropped. */
  finished: string[]
  outgoing: Outgoing[]
  /** The next arrival order to hand out. */
  order: number
}

export function followState(chat: NativeChat | null): FollowState {
  return { chat, cursor: null, events: [], approvals: {}, answered: [], turnStartedAt: null, drafts: [], finished: [], outgoing: [], order: 0 }
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

const turnEnded = (state: NativeChat['state']) => state === 'idle' || state === 'suspended' || state === 'stopped' || state === 'error'

function applyDelta(state: FollowState, delta: ChatDeltaEvent): FollowState {
  if (state.finished.includes(delta.messageId)) return state
  const known = state.drafts.find((draft) => draft.messageId === delta.messageId)
  if (known !== undefined) {
    return { ...state, drafts: state.drafts.map((draft) => (draft === known ? { ...draft, text: draft.text + delta.text } : draft)) }
  }
  return { ...state, drafts: state.drafts.concat({ messageId: delta.messageId, stream: delta.stream, text: delta.text, order: state.order }), order: state.order + 1 }
}

function applyState(state: FollowState, event: ChatStateEvent): FollowState {
  const parsed = nativeChatStateSchema.safeParse(event.text)
  if (!parsed.success) return state
  const value = parsed.data
  const next: FollowState = { ...state, turnStartedAt: turnEnded(value) || value === 'starting' ? null : (event.turnStartedAt ?? state.turnStartedAt) }
  if (state.chat !== null) next.chat = { ...state.chat, state: value }
  // A turn that ended took its unfinished messages with it.
  if (turnEnded(value)) next.drafts = []
  return next
}

const normalized = (text: string) => text.trim().replace(/\s+/g, ' ')

/** The user event confirms the outgoing message with its text, else the oldest one. */
function confirmOutgoing(outgoing: Outgoing[], event: TranscriptEvent): Outgoing[] {
  if (outgoing.length === 0) return outgoing
  const text = normalized(event.text)
  const index = outgoing.findIndex((message) => normalized(message.text) === text)
  return outgoing.filter((_, position) => position !== (index === -1 ? 0 : index))
}

/**
 * Folds one line into the state. A line before the cursor is a replay (a resubscription from an
 * older cursor) and returns the same state, as does a line at the cursor unless it carries a state
 * change (sent at the start of every follow) or a chunk; an event id already shown is not added again.
 * Chunks are never stored and never move the cursor.
 */
export function applyLine(state: FollowState, line: ChatEventLine): FollowState {
  const event = line.event
  if (event?.kind === 'delta') return applyDelta(state, event)
  const order = state.cursor === null ? 1 : compareCursors(line.cursor, state.cursor)
  if (order < 0 || (order === 0 && event?.kind !== 'state')) return state
  let next: FollowState = { ...state, cursor: line.cursor }
  if (line.chat !== undefined) next.chat = line.chat
  if (event === undefined) return next
  if (event.kind === 'state') return applyState(next, event)
  if (state.events.some((known) => known.id === event.id)) return next
  next.events = state.events.concat(event)
  if (line.approval !== undefined) next.approvals = { ...state.approvals, [event.id]: line.approval }
  const messageId = event.messageId
  if (messageId !== undefined) next = { ...next, drafts: next.drafts.filter((draft) => draft.messageId !== messageId), finished: next.finished.concat(messageId) }
  if (event.kind === 'user') next.outgoing = confirmOutgoing(next.outgoing, event)
  return next
}

/** Shows a message the person just sent, before the chat echoes it. */
export function queueOutgoing(state: FollowState, message: Outgoing): FollowState {
  return { ...state, outgoing: state.outgoing.concat({ ...message, order: state.order }), order: state.order + 1 }
}

/** Takes back a message whose send failed. */
export function dropOutgoing(state: FollowState, id: string): FollowState {
  return { ...state, outgoing: state.outgoing.filter((message) => message.id !== id) }
}

/** The live rows in the order they arrived. Each keeps the key its stored event will have. */
export function liveTail(state: FollowState): LiveRow[] {
  const rows: { order: number; item: LiveRow }[] = [
    ...state.drafts.map((draft) => ({ order: draft.order, item: { event: { id: `draft-${draft.messageId}`, at: null, kind: draft.stream, text: draft.text, messageId: draft.messageId }, streaming: true } })),
    ...state.outgoing.map((message) => ({ order: message.order ?? 0, item: { event: { id: `outgoing-${message.id}`, at: message.sentAt, kind: 'user' as const, text: message.text }, pending: true } })),
  ]
  return rows.sort((left, right) => left.order - right.order).map((row) => row.item)
}

/** What the working indicator says and the instant its elapsed time counts from. */
export interface WorkingStatus {
  label: string
  since: string | null
}

const newestEventAt = (state: FollowState): string | null => state.events.reduce<string | null>((newest, event) => (event.at !== null && (newest === null || event.at > newest) ? event.at : newest), null)

/**
 * A chat coming back up. One that already talked reconnects quietly, with no clock; a new one counts from its
 * creation. A start older than the newest event belongs to an earlier life of the chat and is ignored.
 */
function startingStatus(state: FollowState, chat: NativeChat): WorkingStatus {
  const newest = newestEventAt(state)
  if (chat.agentSessionId !== null && newest !== null) return { label: 'Reconnecting…', since: null }
  const since = state.turnStartedAt ?? chat.createdAt
  return { label: `Starting ${chat.agent}…`, since: newest !== null && since < newest ? null : since }
}

/** The working indicator for the followed chat, or null when nothing is running. */
export function workingStatus(state: FollowState): WorkingStatus | null {
  const chat = state.chat
  if (chat === null) return null
  const sentAt = state.outgoing[0]?.sentAt ?? null
  if (chat.state === 'starting') return startingStatus(state, chat)
  if (chat.state === 'waiting-approval') return { label: 'Waiting for approval', since: state.turnStartedAt ?? sentAt }
  if (chat.state !== 'working') return sentAt === null ? null : { label: 'Thinking', since: sentAt }
  const since = state.turnStartedAt ?? sentAt
  const streaming = state.drafts.reduce<Draft | undefined>((newest, draft) => (newest === undefined || draft.order > newest.order ? draft : newest), undefined)
  if (streaming !== undefined) return { label: streaming.stream === 'thinking' ? 'Thinking' : 'Writing', since }
  const last = state.events.at(-1)
  if (last?.kind === 'tool-call') return { label: `Running ${last.tool?.name ?? last.text}`, since }
  return { label: 'Thinking', since }
}

/** Elapsed time as the indicator shows it: 42s, 1m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
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

const RUNNING_TURN_WARNING = 'A turn is running; switching stops it'

/** The terminal opens from every state; a running turn is the one thing the person must agree to stop. */
export function terminalSwitchWarning(chat: NativeChat): string | null {
  return chat.state === 'working' || chat.state === 'waiting-approval' ? RUNNING_TURN_WARNING : null
}

/** Never disabled: the switch resumes a suspended, stopped or failed chat, or starts the agent's TUI fresh. */
export function modeToggle(chat: NativeChat): ModeToggle {
  return { target: chat.mode === 'terminal' ? 'chat' : 'terminal', enabled: true, reason: null }
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
