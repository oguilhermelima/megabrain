import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'
import type { MessagePart, SlashCommand } from '@/api/schema'
import { handleMenuKey } from '@/chat/CommandMenu'
import { draftLength, draftText, tokenAfter, tokenBefore, tokenIds, type Draft } from '@/chat/composer-parts'
import type { QueueControls } from '@/chat/QueueStrip'
import { walkKey } from '@/chat/queue-walk'

export function useComposerKeyboard({ menuOpen, matches, activeMatch, setActive, pick, closeMenu, insertAt, send, selection, current, removeToken, queue, editing, clear, setEditing, load, cancelEdit, editLast, dispatchId, queueDispatch }: {
  menuOpen: boolean
  matches: { command: SlashCommand }[]
  activeMatch: number
  setActive: Dispatch<SetStateAction<number>>
  pick: (command: SlashCommand) => void
  closeMenu: () => void
  insertAt: (text: string) => void
  send: () => void
  selection: () => [number, number]
  current: () => Draft
  removeToken: (id: string) => void
  queue?: QueueControls
  editing: string | null
  clear: () => void
  setEditing: Dispatch<SetStateAction<string | null>>
  load: (parts: readonly MessagePart[]) => void
  cancelEdit: () => void
  /** Up in an empty box takes the last message of the person back to edit (start); Esc leaves that edit (cancel). */
  editLast: { editing: boolean; available: boolean; start: () => void; cancel: () => void }
  dispatchId?: string
  queueDispatch: (action: { type: 'escape'; text: string }) => void
}) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (
      menuOpen &&
      handleMenuKey(event, matches.length, activeMatch, {
        move: setActive,
        pick: () => {
          const item = matches[activeMatch]
          if (item !== undefined) pick(item.command)
        },
        close: closeMenu,
      })
    )
      return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) insertAt('\n')
      else send()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const [start, end] = selection()
      const draftNow = current()
      const id = start !== end ? null : event.key === 'Backspace' ? tokenBefore(draftNow, start) : tokenAfter(draftNow, start)
      if (id !== null) {
        event.preventDefault()
        removeToken(id)
      }
      return
    }
    // The arrows walk the queue from an empty box, and Esc leaves the message being edited; Enter saves through send.
    if (queue !== undefined && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const draftNow = current()
      const [start, end] = selection()
      const length = draftLength(draftNow)
      const step = walkKey({ editing }, event.key, {
        ids: queue.items.map((item) => item.id),
        empty: draftNow.length === 0 || (tokenIds(draftNow).length === 0 && draftText(draftNow).trim() === ''),
        atStart: start === 0 && end === 0,
        atEnd: start === length && end === length,
      })
      if (step.handled) {
        event.preventDefault()
        const effect = step.effect
        if (effect?.type === 'load') {
          const item = queue.items.find((candidate) => candidate.id === effect.id)
          if (item !== undefined) {
            clear()
            setEditing(item.id)
            load(item.parts)
          }
        } else if (effect?.type === 'clear') cancelEdit()
        return
      }
    }
    if (event.key === 'Escape' && editLast.editing && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      editLast.cancel()
      return
    }
    if (event.key === 'ArrowUp' && editLast.available && !editLast.editing && editing === null && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const draftNow = current()
      const [start, end] = selection()
      if (start === 0 && end === 0 && (draftNow.length === 0 || (tokenIds(draftNow).length === 0 && draftText(draftNow).trim() === ''))) {
        event.preventDefault()
        editLast.start()
        return
      }
    }
    if (event.key === 'Escape' && dispatchId !== undefined) {
      event.preventDefault()
      queueDispatch({ type: 'escape', text: draftText(current()) })
    }
  }
}
