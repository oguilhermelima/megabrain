import { useContext, useMemo, useState, type RefObject, type ReactNode } from 'react'
import type { TranscriptEvent } from '@/api/schema'
import { api } from '@/api'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import type { TranscriptSearch } from '@/native-chat/TranscriptSearch'
import { useContextMenu } from '@/components/ContextMenu'
import { ConversationAgent } from '@/components/agent-icons'
import { SelectionBar, type MessageActionsValue } from '@/native-chat/MessageActions'
import { SearchBar } from '@/native-chat/TranscriptSearch'
import { keepShareFooter, messageCopyText, messageRoles, readShareFooter, selectionCopyText, shareFileName } from '@/native-chat/message-actions'
import { emptySelection, selectableIds, selectedInOrder, toggleMessage, type MessageSelection } from '@/native-chat/message-selection'
import { renderPng } from '@/native-chat/share-image'

export function ConversationActionBars({ search, closeSearch, selecting, selection, shareImage, chosen, stopSelecting, failed, setFlash, pinned, onJumpToLatest }: {
  search: TranscriptSearch
  closeSearch: () => void
  selecting: boolean
  selection: MessageSelection
  shareImage: (events: TranscriptEvent[], how: 'copy' | 'save') => Promise<void>
  chosen: () => TranscriptEvent[]
  stopSelecting: () => void
  failed: (caught: unknown) => void
  setFlash: (flash: { text: string; bad: boolean }) => void
  pinned: boolean
  onJumpToLatest: () => void
}) {
  return (
    <>
      {search.open && <SearchBar search={search} onClose={closeSearch} />}
      {selecting && (
        <SelectionBar
          count={selection.ids.length}
          onCopyImage={() => void shareImage(chosen(), 'copy')}
          onDownload={() => void shareImage(chosen(), 'save')}
          onCopyText={() => void api.copyText(selectionCopyText(chosen())).then(() => setFlash({ text: 'Text copied', bad: false }), failed)}
          onCancel={stopSelecting}
        />
      )}
      {!pinned && !selecting && (
        <button type="button" onClick={onJumpToLatest} className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-ink-900/90 px-4 py-1.5 text-chat-small font-semibold text-ink-100 shadow-lg">
          Jump to latest
        </button>
      )}
    </>
  )
}

/** Owns message selection, sharing and the actions exposed by each settled message. */
export function useConversationActions({
  items,
  list,
  busy,
  onEditLast,
  onBranch,
  shareTitle,
  renderCard,
  setFlash,
  failed,
}: {
  items: readonly NoticeDisplayItem[]
  list: RefObject<HTMLDivElement | null>
  busy: boolean
  onEditLast?: (event: TranscriptEvent) => void
  onBranch?: (event: TranscriptEvent) => void
  shareTitle: string | null
  renderCard: (events: TranscriptEvent[], agent: string | null, title: string | null, width: number) => ReactNode
  setFlash: (flash: { text: string; bad: boolean }) => void
  failed: (caught: unknown) => void
}) {
  const contextMenu = useContextMenu()
  const agent = useContext(ConversationAgent)
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<MessageSelection>(emptySelection)
  const [shareFooter, setShareFooter] = useState(readShareFooter)
  const order = useMemo(() => selectableIds(items), [items])
  const byId = useMemo(() => new Map(items.flatMap((item) => (item.type === 'message' ? [[item.event.id, item.event] as const] : []))), [items])
  const roles = useMemo(() => ({ latest: messageRoles(items, false).lastPerson, ...messageRoles(items, busy) }), [items, busy])
  const cardWidth = () => Math.min(880, Math.max(520, list.current?.clientWidth ?? 720))
  const shareImage = (events: TranscriptEvent[], how: 'copy' | 'save') =>
    renderPng(renderCard(events, agent, shareFooter ? shareTitle : null, cardWidth()))
      .then(async (png) => {
        if (how === 'copy') {
          await api.copyImage(png)
          setFlash({ text: events.length === 1 ? 'Image copied' : `Image of ${events.length} messages copied`, bad: false })
        } else if (await api.saveImageAs(png, shareFileName(shareTitle, events.length))) setFlash({ text: 'Image saved', bad: false })
      })
      .catch(failed)
  const stopSelecting = () => {
    setSelecting(false)
    setSelection(emptySelection)
  }
  const chosen = () => selectedInOrder(selection, order).flatMap((id) => byId.get(id) ?? [])
  const actions = useMemo<MessageActionsValue>(
    () => ({
      copy: (event) => api.copyText(messageCopyText(event)).catch((caught: unknown) => {
        failed(caught)
        throw caught
      }),
      copyText: (text) => api.copyText(text).then(() => setFlash({ text: 'Text copied', bad: false }), failed),
      menu: (trigger, sections) => contextMenu.open(trigger, sections),
      share: (event, trigger) =>
        contextMenu.open(trigger, [
          [
            { label: 'Copy image', icon: 'copy', onSelect: () => void shareImage([event], 'copy') },
            { label: 'Download PNG', icon: 'save', onSelect: () => void shareImage([event], 'save') },
          ],
          [
            {
              label: shareFooter ? 'Leave out the chat title' : 'Show the chat title',
              icon: 'chat',
              onSelect: () => {
                setShareFooter(!shareFooter)
                keepShareFooter(!shareFooter)
              },
            },
          ],
        ]),
      select: (event) => {
        setSelecting(true)
        setSelection(toggleMessage(emptySelection, event.id, order, false))
      },
      selecting,
      selected: new Set(selection.ids),
      toggle: (id, range) => setSelection((current) => toggleMessage(current, id, order, range)),
      lastPerson: roles.latest,
      editDisabled: busy,
      edit: onEditLast ?? null,
      turnEnds: roles.turnEnds,
      lastAnswer: roles.lastAnswer,
      branch: onBranch ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selecting, selection, order, roles, busy, onEditLast, onBranch, shareFooter, agent, shareTitle],
  )
  return { actions, selecting, selection, shareImage, stopSelecting, chosen, contextMenu }
}
