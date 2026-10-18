import { useMemo, useState } from 'react'
import { api } from '@/api'
import type { MessagePart, NativeChat, TranscriptEvent } from '@/api/schema'
import type { Notice } from '@/chat/Composer'
import { announceAction } from '@/lib/app-events'
import { editableParts } from '@/native-chat/message-actions'
import { dropOutgoing, queueOutgoing, rewindEvents, type FollowState } from '@/native-chat/chat-model'

/** Owns editing the latest user message and branching from a completed answer. */
export function useChatMessageEditing({
  chat,
  events,
  busy,
  update,
  act,
  onOpenNativeChat,
}: {
  chat: NativeChat
  events: TranscriptEvent[]
  busy: boolean
  update: (change: (current: FollowState) => FollowState) => void
  act: (run: () => Promise<void>) => void
  onOpenNativeChat?: (chat: NativeChat) => void
}) {
  const lastPerson = useMemo(() => events.filter((event) => event.kind === 'user').at(-1) ?? null, [events])
  const lastMessage = useMemo(() => (lastPerson === null || busy ? null : { parts: editableParts(lastPerson) }), [lastPerson, busy])
  const [editRequest, setEditRequest] = useState<{ parts: MessagePart[] } | null>(null)
  const requestEdit = (event: TranscriptEvent) => setEditRequest({ parts: editableParts(event) })
  const editLast = async (parts: MessagePart[]): Promise<Notice | null> => {
    const from = lastPerson
    // Show the replacement at once; its chat echo can arrive before the edit call returns.
    const id = crypto.randomUUID()
    const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    const images = parts.flatMap((part) => (part.type === 'image' ? [{ path: part.path }] : []))
    update((current) => queueOutgoing(current, { id, text, sentAt: new Date().toISOString(), ...(images.length === 0 ? {} : { images, parts }) }))
    try {
      await api.editLastMessage(chat.id, parts)
    } catch (caught) {
      update((current) => dropOutgoing(current, id))
      return { tone: 'bad', text: caught instanceof Error ? caught.message : String(caught) }
    }
    // The stored rewind line reaches this same updater; once it has, applying this is idempotent.
    if (from !== null) update((current) => rewindEvents(current, from.id))
    announceAction()
    return null
  }
  // A branch opens beside this chat with the transcript through the selected answer.
  const branch = (event: TranscriptEvent) =>
    void act(async () => {
      const forked = await api.forkChat(chat.id, event.id)
      onOpenNativeChat?.(forked)
    })

  return { lastMessage, editRequest, requestEdit, editLast, branch }
}
