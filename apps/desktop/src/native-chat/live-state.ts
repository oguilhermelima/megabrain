import { useSyncExternalStore } from 'react'
import type { NativeChat } from '@/api/schema'

// The state of each chat an open view follows, so the sidebar row shows a turn the moment it starts
// instead of on the next poll of the chat list.

const states = new Map<string, NativeChat['state']>()
const listeners = new Set<() => void>()

export function publishChatState(chatId: string, state: NativeChat['state'] | null) {
  if ((states.get(chatId) ?? null) === state) return
  if (state === null) states.delete(chatId)
  else states.set(chatId, state)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The followed state of a chat, or the listed one while no view follows it. */
export function useChatState(chat: NativeChat): NativeChat['state'] {
  return useSyncExternalStore(subscribe, () => states.get(chat.id) ?? chat.state)
}
