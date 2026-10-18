import type { TranscriptEvent } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'
import { readAll, writeChat } from '@/native-chat/chat-artifacts'

// Where the person stopped reading each chat, so reopening it marks where the unseen messages begin.
// The mark is per viewer and stays on this machine; chatd's history knows nothing of it.

/** Every chat's last seen event id under one key, the most recently written chat last. */
export const lastSeenStoreKey = 'megabrain.chat.last-seen'

/** The id of the newest event the person saw in the chat, or null for a chat never seen. */
export function readLastSeen(storage: () => WidthStorage, chatId: string): string | null {
  const entry = readAll(storage, lastSeenStoreKey)[chatId]
  return typeof entry === 'string' ? entry : null
}

/** Remembers the newest event the person saw; not remembering it is fine. */
export function writeLastSeen(storage: () => WidthStorage, chatId: string, eventId: string) {
  if (readLastSeen(storage, chatId) !== eventId) writeChat(storage, lastSeenStoreKey, chatId, eventId)
}

/**
 * The agent message the New divider goes above: the first of the chat's own answers after the last seen
 * event that the agent wrote before the view opened (`openedAt`, in ms). An answer written while the
 * person looks is not unseen. Null for a chat never seen, or one whose last seen event is gone (rewound).
 * Events only append, so once found the answer stays the same while more arrive.
 */
export function unseenDivider(events: TranscriptEvent[], lastSeen: string | null, openedAt: number): string | null {
  if (lastSeen === null) return null
  const seenAt = events.findIndex((event) => event.id === lastSeen)
  if (seenAt === -1) return null
  for (let index = seenAt + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined || event.kind !== 'assistant' || event.parentId !== undefined) continue
    if (event.at === null || Date.parse(event.at) < openedAt) return event.id
  }
  return null
}
