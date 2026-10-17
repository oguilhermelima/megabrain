import { useEffect, useState } from 'react'
import type { MessagePart } from '@/api/schema'
import type { QueueControls } from '@/chat/QueueStrip'
import { fromPath, releasePreview, type Attachment } from '@/chat/ComposerSupport'
import { draftLength, draftText, type Draft } from '@/chat/composer-parts'
import type { Notice } from '@/chat/composer-look'
import { reconcileWalk } from '@/chat/queue-walk'

export function useComposerQueueEditing({ queue, draft, attachments, apply, show }: {
  queue?: QueueControls
  draft: Draft
  attachments: Map<string, Attachment>
  apply: (next: Draft, offset: number) => void
  show: (next: Notice | null) => void
}) {
  // The queued message the box holds for editing: Enter saves it, and the queue moves it to its end; Esc gives it back unchanged.
  const [editing, setEditing] = useState<string | null>(null)
  const queueItems = queue?.items
  useEffect(() => {
    setEditing((current) => reconcileWalk({ editing: current }, queueItems?.map((item) => item.id) ?? []).editing)
  }, [queueItems])

  /** Puts a message's parts in the box, its image paths as tokens, with the caret at the end. */
  const load = (parts: readonly MessagePart[]) => {
    const next = parts.flatMap((part): Draft => {
      if (part.type === 'text') return [part]
      const attachment = fromPath(part.path)
      if (attachment === null) return [{ type: 'text', text: part.path }]
      attachments.set(attachment.id, attachment)
      return [{ type: 'token', id: attachment.id }]
    })
    apply(next, draftLength(next))
  }

  /** Empties the box and lets go of its attachments. */
  const clear = () => {
    apply([], 0)
    attachments.forEach(releasePreview)
    attachments.clear()
  }

  /** Takes a queued message into the box to edit; whatever was being edited is given back unchanged. */
  const editQueued = (id: string) => {
    const item = queue?.items.find((candidate) => candidate.id === id)
    if (item === undefined) return
    const sendable = draft.some((part) => part.type === 'token') || draftText(draft).trim() !== ''
    if (editing === null && sendable) {
      show({ tone: 'bad', text: 'Send or clear the message in the box before editing a queued one.' })
      return
    }
    clear()
    setEditing(id)
    load(item.parts)
  }

  /** Leaves the edit: the queued message stays as it was. */
  const cancelEdit = () => {
    setEditing(null)
    clear()
  }

  return { editing, setEditing, load, clear, editQueued, cancelEdit }
}
