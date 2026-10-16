import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { NativeChat } from '@/api/schema'
import { applyLine, followState, type FollowState } from '@/native-chat/chat-model'
import { publishChatState } from '@/native-chat/live-state'

// What each chat view has seen, kept for the app run: reopening a chat shows it at once and the
// subscription resumes after the last cursor instead of replaying the whole conversation.
const seen = new Map<string, FollowState>()

/** Follows a native chat live while the view is open; the subscription closes when it leaves. */
export function useFollowChat(chat: NativeChat): { state: FollowState; error: unknown; update: (change: (state: FollowState) => FollowState) => void } {
  const [state, setState] = useState<FollowState>(() => seen.get(chat.id) ?? followState(chat))
  const [error, setError] = useState<unknown>(null)

  const update = (change: (current: FollowState) => FollowState) =>
    setState((current) => {
      const next = change(current)
      seen.set(chat.id, next)
      return next
    })

  useEffect(() => {
    let stopped = false
    let stop: (() => void) | undefined
    const since = (seen.get(chat.id) ?? null)?.cursor ?? null
    setError(null)
    api
      .followChat(chat.id, since, (line) => {
        if (!stopped) update((current) => applyLine(current, line))
      })
      .then(
        (unsubscribe) => {
          if (stopped) unsubscribe()
          else stop = unsubscribe
        },
        (caught: unknown) => {
          if (!stopped) setError(caught)
        },
      )
    return () => {
      stopped = true
      stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  // The sidebar row follows the live state while this view is open, and the listed one after.
  const live = state.chat?.state ?? null
  useEffect(() => publishChatState(chat.id, live), [chat.id, live])
  useEffect(() => () => publishChatState(chat.id, null), [chat.id])

  return { state, error, update }
}
