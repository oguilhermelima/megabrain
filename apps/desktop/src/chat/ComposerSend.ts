import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { MessagePart } from '@/api/schema'
import type { QueueControls } from '@/chat/QueueStrip'
import { attachmentPath, type Attachment } from '@/chat/ComposerSupport'
import { draftText, toMessageParts, tokenIds, type Draft } from '@/chat/composer-parts'
import { keepsDraft, type Notice } from '@/chat/composer-look'

// What a queued message's edit answers when chatd had already sent the message.
const TAKEN = Symbol('taken')

export function useComposerSend({ current, attachments, sending, setSending, disabled, show, editing, setEditing, queue, onSend, clear, onSent }: {
  current: () => Draft
  attachments: MutableRefObject<Map<string, Attachment>>
  sending: boolean
  setSending: Dispatch<SetStateAction<boolean>>
  disabled: boolean
  show: (next: Notice | null, fromSend?: boolean) => void
  editing: string | null
  setEditing: Dispatch<SetStateAction<string | null>>
  queue?: QueueControls
  onSend: (parts: MessagePart[]) => Promise<Notice | null>
  clear: () => void
  onSent: () => void
}) {
  return () => {
    const message = current().filter((part) => part.type === 'text' || attachments.current.has(part.id))
    const ids = tokenIds(message)
    if ((ids.length === 0 && draftText(message).trim() === '') || sending || disabled) return
    setSending(true)
    show(null)
    Promise.all(
      ids.map(async (id) => {
        const attachment = attachments.current.get(id)
        if (attachment === undefined) throw new Error('An attachment went missing; attach it again.')
        return [id, { kind: attachment.kind, path: await attachmentPath(attachment) }] as const
      }),
    )
      .then((saved): Promise<Notice | typeof TAKEN | null> => {
        const paths = new Map(saved)
        const parts = toMessageParts(message, (id) => {
          const found = paths.get(id)
          if (found === undefined) throw new Error('An attachment went missing; attach it again.')
          return found
        })
        // An edited queued message is saved in place of being sent; the queue moves it to its end.
        const edited = editing === null ? undefined : queue?.items.find((item) => item.id === editing)
        if (edited !== undefined && queue !== undefined) return queue.edit(edited.id, parts).then((outcome) => (outcome === 'taken' ? TAKEN : null))
        return onSend(parts)
      })
      .then(
        (result) => {
          // The message was sent before the edit landed: the box keeps the edited text as a plain draft.
          if (result === TAKEN) {
            setEditing(null)
            show({ tone: 'ok', text: 'Already sent; your edit is in the composer.' })
            return
          }
          show(result, result?.tone === 'bad')
          onSent()
          if (!keepsDraft(result)) {
            setEditing(null)
            clear()
          }
        },
        (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }, true),
      )
      .finally(() => setSending(false))
  }
}
