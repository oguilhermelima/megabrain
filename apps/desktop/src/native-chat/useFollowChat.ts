import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { ChatQueueItem, NativeChat } from '@/api/schema'
import { applyLine, followState, type FollowState } from '@/native-chat/chat-model'
import { startChatSync } from '@/native-chat/chat-sync'
import { publishChatState } from '@/native-chat/live-state'
import { startEvent, startStep } from '@/native-chat/start-trace'
import { switchState } from '@/native-chat/switch-trace'

// What each chat view has seen, kept for the app run: reopening a chat shows it at once and the
// subscription resumes after the last cursor instead of replaying the whole conversation.
const seen = new Map<string, FollowState>()
// Each chat's queue as last heard, so reopening shows it before the follow's first line repeats it.
const seenQueue = new Map<string, ChatQueueItem[]>()

/** Follows a native chat live while the view is open; the subscription closes when it leaves. */
export function useFollowChat(chat: NativeChat): {
  state: FollowState
  /** Why the follow is down while it comes back ('' with no reason), null while it is live. */
  reconnecting: string | null
  update: (change: (state: FollowState) => FollowState) => void
  /** The messages waiting for the turn to end, as chatd last said; a queue call's answer sets it too. */
  queue: ChatQueueItem[]
  setQueue: (items: ChatQueueItem[]) => void
  /** Counts the artifacts events this follow delivered: each says the chat's artifacts changed. */
  artifactsChanged: number
} {
  const [state, setState] = useState<FollowState>(() => seen.get(chat.id) ?? followState(chat))
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [artifactsChanged, setArtifactsChanged] = useState(0)
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
    // Every follow, the first and each one after an end, resumes after the last cursor applied and
    // starts with the chat's current state and queue, so the view never keeps a state the daemon has
    // left. A check on focus, on showing the window and every few seconds while shown catches a
    // follow that stays open but stops delivering.
    setReconnecting(null)
    startStep(chat.id, 'followCalled')
    const sync = startChatSync({
      chatId: chat.id,
      api,
      cursor: () => seen.get(chat.id)?.cursor ?? null,
      onLine: (line) => {
        // The queue rides on its own lines, the whole of it each time; the latest wins.
        if (line.queue !== undefined) setQueue(line.queue)
        if (line.event?.kind === 'artifacts') return setArtifactsChanged((count) => count + 1)
        update((current) => applyLine(current, line))
        if (line.event?.kind === 'state') switchState(chat.id, line.event.text)
        // A progress report is no output of the agent's start.
        if (line.event !== undefined && line.event.kind !== 'progress') startEvent(chat.id, line.event)
      },
      onReconnecting: setReconnecting,
      visible: () => document.visibilityState === 'visible',
    })
    const check = () => {
      if (document.visibilityState === 'visible') void sync.check()
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
      sync.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  // The sidebar row follows the live state while this view is open, and the listed one after.
  const live = state.chat?.state ?? null
  useEffect(() => publishChatState(chat.id, live), [chat.id, live])
  useEffect(() => () => publishChatState(chat.id, null), [chat.id])

  return { state, reconnecting, update, queue, setQueue, artifactsChanged }
}
