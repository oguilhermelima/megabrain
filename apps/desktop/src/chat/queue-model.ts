import type { QueuedMessage } from '@/api/schema'

// The queue under a dispatch chat's composer, as a pure reducer. Esc in an empty composer takes the
// newest message still waiting back for editing, like Claude Code; one already delivered cannot be.

export interface QueueState {
  /** Messages still waiting to reach the chat, oldest first. */
  pending: QueuedMessage[]
  /** The message being taken back, while unqueue runs. */
  taking: string | null
  /** A message taken back, for the composer to pick up. */
  restored: { id: string; text: string } | null
  hint: string | null
}

export type QueueAction =
  | { type: 'refresh'; items: QueuedMessage[] }
  | { type: 'escape'; text: string }
  | { type: 'restored'; id: string; text: string }
  | { type: 'restore-failed'; id: string }
  | { type: 'typed' }

export const initialQueueState: QueueState = { pending: [], taking: null, restored: null, hint: null }

const waiting = (item: QueuedMessage) => item.state === 'outstanding'

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'refresh': {
      const pending = action.items.filter((item) => waiting(item) && item.id !== state.taking).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      return { ...state, pending }
    }
    case 'escape': {
      if (action.text.trim() !== '' || state.taking !== null) return state
      const newest = state.pending.at(-1)
      if (newest === undefined) return { ...state, restored: null, hint: 'Nothing waiting to take back. A message already delivered cannot be taken back.' }
      return { ...state, pending: state.pending.slice(0, -1), taking: newest.id, restored: null, hint: null }
    }
    case 'restored':
      return { ...state, taking: null, restored: { id: action.id, text: action.text }, hint: null }
    case 'restore-failed':
      return { ...state, taking: null, restored: null, hint: 'That message was already delivered and cannot be taken back.' }
    case 'typed':
      return state.hint === null ? state : { ...state, hint: null }
  }
}
