import type { Virtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, type RefObject } from 'react'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { useSearchHighlights, useTranscriptSearch } from '@/native-chat/TranscriptSearch'
import { matchedTurns } from '@/native-chat/transcript-search'

/** Connects transcript search to virtual rows, keyboard shortcuts and the turn navigator. */
export function useConversationSearch({
  items,
  turns,
  virtualizer,
  list,
  searchRef,
  setPinned,
}: {
  items: readonly NoticeDisplayItem[]
  turns: readonly { row: number }[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  list: RefObject<HTMLDivElement | null>
  searchRef?: { current: (() => void) | null }
  setPinned: (pinned: boolean) => void
}) {
  const search = useTranscriptSearch(items, () => {
    const offset = virtualizer.scrollOffset ?? 0
    return virtualizer.getVirtualItems().find((row) => row.end > offset)?.index ?? 0
  })
  useSearchHighlights(search, list, virtualizer, () => setPinned(false))
  useEffect(() => {
    if (searchRef === undefined) return
    searchRef.current = search.show
    return () => {
      searchRef.current = null
    }
  })
  const marked = useMemo(() => new Set(matchedTurns(turns.map((turn) => turn.row), search.matches)), [turns, search.matches])
  const closeSearch = () => {
    search.close()
    list.current?.focus({ preventScroll: true })
  }
  return { search, marked, closeSearch }
}
