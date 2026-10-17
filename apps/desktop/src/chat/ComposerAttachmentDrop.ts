import { useEffect, type RefObject } from 'react'
import type { Notice } from '@/chat/composer-look'
import { insertToken, deleteRange, type Draft } from '@/chat/composer-parts'
import { offsetAtPoint } from '@/chat/rich-input'
import { insideModal, useWindowDrop } from '@/lib/window-drop'
import { fromPath, releasePreview, type Attachment } from '@/chat/ComposerSupport'

export function useComposerAttachmentDrop({ editor, disabled, attachments, current, selection, apply, show }: {
  editor: RefObject<HTMLDivElement | null>
  disabled: boolean
  attachments: Map<string, Attachment>
  current: () => Draft
  selection: () => [number, number]
  apply: (next: Draft, offset: number) => void
  show: (next: Notice | null) => void
}) {
  /** Puts attachments into the text where the caret or the drop is, one token each. */
  const attach = (added: (Attachment | null)[], [start, end]: [number, number] = selection()) => {
    const accepted = added.filter((item): item is Attachment => item !== null)
    if (accepted.length < added.length) show({ tone: 'bad', text: 'Only images and PDFs can be attached.' })
    if (accepted.length === 0) return
    let next = deleteRange(current(), start, end)
    let offset = start
    for (const attachment of accepted) {
      attachments.set(attachment.id, attachment)
      next = insertToken(next, offset, attachment.id)
      offset += 1
    }
    apply(next, offset)
  }

  useWindowDrop(
    {
      onDrop: (paths, x, y) => {
        // A drop on an open dialog (Import project takes folders) is the dialog's, not the chat's.
        if (insideModal(x, y)) return
        const at = editor.current === null ? null : offsetAtPoint(editor.current, x, y)
        attach(paths.map(fromPath), at === null ? undefined : [at, at])
      },
    },
    !disabled,
  )

  useEffect(
    () => () => {
      attachments.forEach(releasePreview)
    },
    [],
  )

  return attach
}
