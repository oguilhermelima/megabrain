import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { ChatQueueItem, NativeChat } from '@/api/schema'
import { applyLine, followState, type FollowState } from '@/native-chat/chat-model'
import { publishChatState } from '@/native-chat/live-state'
import { startEvent, startStep } from '@/native-chat/start-trace'
import { switchState } from '@/native-chat/switch-trace'

// What each chat view has seen, kept for the app run: reopening a chat shows it at once and the
// subscription resumes after the last cursor instead of replaying the whole conversation.
const seen = new Map<string, FollowState>()
// Each chat's queue as last heard, so reopening shows it before the follow's first line repeats it.
const seenQueue = new Map<string, ChatQueueItem[]>()

// A follow that ends on its own (chatd restarted, the CLI died) comes back after this long, doubling to the cap.
const RETRY_MS = 300
const RETRY_CAP_MS = 5000

/** Follows a native chat live while the view is open; the subscription closes when it leaves. */
export function useFollowChat(chat: NativeChat): {
  state: FollowState
  error: unknown
  update: (change: (state: FollowState) => FollowState) => void
  /** The messages waiting for the turn to end, as chatd last said; a queue call's answer sets it too. */
  queue: ChatQueueItem[]
  setQueue: (items: ChatQueueItem[]) => void
} {
  const [state, setState] = useState<FollowState>(() => seen.get(chat.id) ?? followState(chat))
  const [error, setError] = useState<unknown>(null)
  const [queue, setQueueState] = useState<ChatQueueItem[]>(() => seenQueue.get(chat.id) ?? [])
  const setQueue = (items: ChatQueueItem[]) => {
    seenQueue.set(chat.id, items)
    setQueueState(items)
  }

  const update = (change: (current: FollowState) => FollowState) =>
    setState((current) => {
      const next = change(current)
      seen.set(chat.id, next)
      return next
    })

  useEffect(() => {
    let stopped = false
    let stop: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = RETRY_MS
    // Every follow, the first and each one after an end, resumes after the last cursor applied and
    // starts with the chat's current state, so the view never keeps a state the daemon has left.
    const follow = () => {
      const since = (seen.get(chat.id) ?? null)?.cursor ?? null
      api
        .followChat(
          chat.id,
          since,
          (line) => {
            if (stopped) return
            delay = RETRY_MS
            setError(null)
            // The queue rides on its own lines, the whole of it each time; the latest wins.
            if (line.queue !== undefined) setQueue(line.queue)
            update((current) => applyLine(current, line))
            if (line.event?.kind === 'state') switchState(chat.id, line.event.text)
            // A progress report is no output of the agent's start.
            if (line.event !== undefined && line.event.kind !== 'progress') startEvent(chat.id, line.event)
          },
          (ended) => {
            if (stopped) return
            if (ended !== null) setError(new Error(ended))
            stop = undefined
            retry = setTimeout(follow, delay)
            delay = Math.min(delay * 2, RETRY_CAP_MS)
          },
        )
        .then(
          (unsubscribe) => {
            if (stopped) unsubscribe()
            else stop = unsubscribe
          },
          (caught: unknown) => {
            if (!stopped) setError(caught)
          },
        )
    }
    setError(null)
    startStep(chat.id, 'followCalled')
    follow()
    return () => {
      stopped = true
      if (retry !== undefined) clearTimeout(retry)
      stop?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  // The sidebar row follows the live state while this view is open, and the listed one after.
  const live = state.chat?.state ?? null
  useEffect(() => publishChatState(chat.id, live), [chat.id, live])
  useEffect(() => () => publishChatState(chat.id, null), [chat.id])

  return { state, error, update, queue, setQueue }
}
