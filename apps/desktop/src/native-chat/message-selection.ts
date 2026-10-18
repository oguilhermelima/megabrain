import type { NoticeDisplayItem } from '@/chat/notice-model'

// Selecting messages to share: a click toggles one, a shift-click adds the run from the last one clicked.
// The selection keeps ids; what is shared is always in transcript order.

export interface MessageSelection {
  ids: string[]
  /** The message last clicked without Shift, where a range starts. */
  anchor: string | null
}

export const emptySelection: MessageSelection = { ids: [], anchor: null }

/** The messages that can be selected, in transcript order: the person's and the assistant's, settled. */
export function selectableIds(items: readonly NoticeDisplayItem[]): string[] {
  return items.flatMap((item) =>
    item.type === 'message' && item.streaming !== true && item.pending !== true && (item.event.kind === 'user' || item.event.kind === 'assistant') ? [item.event.id] : [],
  )
}

export function toggleMessage(selection: MessageSelection, id: string, order: readonly string[], range: boolean): MessageSelection {
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor)
  const to = order.indexOf(id)
  if (range && from !== -1 && to !== -1) {
    const run = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    return { ids: [...new Set([...selection.ids, ...run])], anchor: selection.anchor }
  }
  const ids = selection.ids.includes(id) ? selection.ids.filter((known) => known !== id) : [...selection.ids, id]
  return { ids, anchor: id }
}

/** The selected ids in transcript order; one no longer shown drops out. */
export function selectedInOrder(selection: MessageSelection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.includes(id))
}
