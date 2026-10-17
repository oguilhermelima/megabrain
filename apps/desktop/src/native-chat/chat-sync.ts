import type { ChatQueueChange, DesktopApi } from '@/api/adapter'
import type { ChatEventLine, ChatQueueItem } from '@/api/schema'
import { compareCursors } from '@/native-chat/chat-model'

// Keeps an open chat view converging on chatd, which is the only source of its state, queue and
// events. A follow streams them; a follow that ends comes back with backoff; and while the chat is
// visible a cheap read compares it with chatd and repairs whatever the follow did not deliver.

export type SyncApi = Pick<DesktopApi, 'followChat' | 'chatEvents'>

export interface Timers {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// A follow that ends on its own (chatd restarted, the CLI died) comes back after this long, doubling to the cap.
const RETRY_MS = 300
const RETRY_CAP_MS = 5000
/** How often a visible chat reads chatd to compare. */
export const CHECK_MS = 5000

const reasonOf = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))
const newer = (cursor: string, than: string | null) => cursor !== '' && (than === null || compareCursors(cursor, than) > 0)

export interface ChatSyncOptions {
  chatId: string
  api: SyncApi
  /** The cursor the view has applied, where a follow or a read resumes. */
  cursor: () => string | null
  onLine: (line: ChatEventLine) => void
  /** Why the follow is down while it comes back ('' when it ended without an error), null once it is live again. */
  onReconnecting: (reason: string | null) => void
  visible: () => boolean
  timers?: Timers
}

/** Follows the chat and checks it against chatd until stopped. `check` runs a comparison now. */
export function startChatSync({ chatId, api, cursor, onLine, onReconnecting, visible, timers = realTimers }: ChatSyncOptions): { check: () => Promise<void>; stop: () => void } {
  let stopped = false
  // Each follow has its generation; lines and ends from a follow already replaced are ignored.
  let generation = 0
  let unsubscribe: (() => void) | undefined
  let retry: unknown
  let periodic: unknown
  let delay = RETRY_MS
  let reconnecting = false
  // The newest cursor the current follow delivered, and a newer one a check read that it had not.
  let followed: string | null = null
  let missed: string | null = null
  let checking = false

  const lost = (reason: string | null) => {
    unsubscribe = undefined
    reconnecting = true
    onReconnecting(reason ?? '')
    retry = timers.set(follow, delay)
    delay = Math.min(delay * 2, RETRY_CAP_MS)
  }

  function follow() {
    retry = undefined
    generation += 1
    const mine = generation
    const since = cursor()
    followed = since
    const current = () => !stopped && mine === generation
    api
      .followChat(
        chatId,
        since,
        (line) => {
          if (!current()) return
          delay = RETRY_MS
          if (reconnecting) {
            reconnecting = false
            onReconnecting(null)
          }
          if (newer(line.cursor, followed)) followed = line.cursor
          onLine(line)
        },
        (ended) => {
          if (current()) lost(ended)
        },
      )
      .then(
        (stop) => {
          if (current()) unsubscribe = stop
          else stop()
        },
        (caught: unknown) => {
          if (current()) lost(reasonOf(caught))
        },
      )
  }

  const restart = () => {
    unsubscribe?.()
    unsubscribe = undefined
    if (retry !== undefined) timers.clear(retry)
    follow()
  }

  // A follow still short of what the last check read is stuck, so it is replaced; what the check read
  // is applied at once either way. A read that fails changes nothing and the next one tries again.
  const check = async () => {
    if (stopped || checking) return
    checking = true
    try {
      if (missed !== null && newer(missed, followed)) restart()
      missed = null
      const lines = await api.chatEvents(chatId, cursor())
      if (stopped) return
      for (const line of lines) onLine(line)
      const last = lines.length > 1 ? (lines.at(-1)?.cursor ?? null) : null
      if (last !== null && newer(last, followed)) missed = last
    } catch {
      // The follow, or the next check, brings the view up to date.
    } finally {
      checking = false
    }
  }

  const tick = () => {
    periodic = timers.set(() => {
      if (visible()) void check()
      tick()
    }, CHECK_MS)
  }

  follow()
  tick()
  return {
    check,
    stop: () => {
      stopped = true
      if (retry !== undefined) timers.clear(retry)
      timers.clear(periodic)
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

// chatd's refusal when a queued message is no longer there: the turn took it, or another view changed it.
const takenFromQueue = (caught: unknown) => caught instanceof Error && caught.message.includes('is not in the queue')

/**
 * Changes the queue and answers with it. A message chatd already took is no failure: the queue is
 * read again and `taken` says so, which an edit needs to keep the person's text.
 */
export async function changeChatQueue(api: Pick<DesktopApi, 'chatQueue'>, chatId: string, change: ChatQueueChange): Promise<{ items: ChatQueueItem[]; taken: boolean }> {
  try {
    return { items: await api.chatQueue(chatId, change), taken: false }
  } catch (caught) {
    if (!takenFromQueue(caught)) throw caught
    return { items: await api.chatQueue(chatId, { action: 'list' }), taken: true }
  }
}
