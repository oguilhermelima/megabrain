import type { NativeChat } from '@/api/schema'

// The panes the last run left come back as they were. A chat open in a pane stays there across the
// restart without starting its agent: the agent starts when the person sends to it. The layout is
// pruned once, and only after every list that names its items has loaded, so a chat list that is slow
// to come back (chatd still starting) or failed this once never empties the chat panes.

export type LoadedLists = { status: boolean; projects: boolean; terminals: boolean; chats: boolean }

export function readyToPrune(lists: LoadedLists): boolean {
  return lists.status && lists.projects && lists.terminals && lists.chats
}

/** A restored chat pane stays while its chat is listed, whatever its state or mode. */
export function chatPaneStays(chats: readonly NativeChat[], id: string): boolean {
  return chats.some((chat) => chat.id === id)
}
