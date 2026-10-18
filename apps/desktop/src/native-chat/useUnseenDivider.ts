import { useEffect, useMemo, useState } from 'react'
import type { TranscriptEvent } from '@/api/schema'
import { readLastSeen, unseenDivider, writeLastSeen } from '@/native-chat/unseen'

const browserStorage = () => localStorage

/**
 * The New divider of an open chat. Where the person last stopped is read once, when the chat opens, so
 * the divider stays put while they read; the newest event is remembered as seen whenever the chat shows
 * at its bottom in a visible window. Sending dismisses the divider for the rest of the visit.
 */
export function useUnseenDivider(chatId: string, events: TranscriptEvent[], atLatest: boolean): { divider: string | null; dismiss: () => void } {
  const opened = () => ({ chatId, lastSeen: readLastSeen(browserStorage, chatId), openedAt: Date.now(), dismissed: false })
  const [visit, setVisit] = useState(opened)
  const current = visit.chatId === chatId ? visit : opened()
  if (current !== visit) setVisit(current)

  const divider = useMemo(
    () => (current.dismissed ? null : unseenDivider(events, current.lastSeen, current.openedAt)),
    [events, current.dismissed, current.lastSeen, current.openedAt],
  )

  const newest = events.at(-1)?.id ?? null
  useEffect(() => {
    if (newest === null || !atLatest) return
    const mark = () => {
      if (document.visibilityState === 'visible') writeLastSeen(browserStorage, chatId, newest)
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [chatId, newest, atLatest])

  return { divider, dismiss: () => setVisit((previous) => (previous.dismissed ? previous : { ...previous, dismissed: true })) }
}
