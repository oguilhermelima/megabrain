import type { ClipboardEvent, MouseEvent, RefObject } from 'react'
import { api } from '@/api'
import type { Draft } from '@/chat/composer-parts'
import { deleteRange } from '@/chat/composer-parts'
import { composerMenu, type ComposerAction } from '@/chat/chat-menu-model'
import { toSections } from '@/chat/chat-menu'
import type { MenuIcon } from '@/components/menu-icons'
import { useContextMenu } from '@/components/ContextMenu'
import { fromFile, type Attachment } from '@/chat/ComposerSupport'
import type { Notice } from '@/chat/composer-look'

export function useComposerClipboard({ editor, picker, disabled, current, selection, apply, insertAt, attach, show }: {
  editor: RefObject<HTMLDivElement | null>
  picker: RefObject<HTMLInputElement | null>
  disabled: boolean
  current: () => Draft
  selection: () => [number, number]
  apply: (next: Draft, offset: number) => void
  insertAt: (text: string, range?: [number, number]) => void
  attach: (added: (Attachment | null)[], at?: [number, number]) => void
  show: (next: Notice | null) => void
}) {
  const contextMenu = useContextMenu()
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0) {
      attach(files.map(fromFile))
      return
    }
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    if (text !== '') insertAt(text)
  }

  // The box's own right-click menu: it covers cut, copy, paste and select all, so it replaces the
  // webview's. Paste reads the clipboard natively, as the webview's would ask before each read.
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const element = editor.current
    if (element === null) return
    const range = selection()
    const selected = window.getSelection()
    const text = selected !== null && !selected.isCollapsed && element.contains(selected.anchorNode) ? selected.toString() : ''
    const failed = (caught: unknown) => show({ tone: 'bad', text: caught instanceof Error ? caught.message : String(caught) })
    const pasteText = () => api.pasteText().catch(() => '')
    const run = (action: ComposerAction) => {
      switch (action) {
        case 'cut':
          api.copyText(text).then(() => apply(deleteRange(current(), range[0], range[1]), range[0]), failed)
          return
        case 'copy':
          api.copyText(text).catch(failed)
          return
        case 'paste':
          // Text first, as the box takes it; an image only when the clipboard has no text.
          pasteText()
            .then(async (pasted) => {
              if (pasted !== '') return insertAt(pasted.replace(/\r\n?/g, '\n'), range)
              const image = await api.pasteImage()
              if (image !== null) attach([fromFile(image)], range)
            })
            .catch(failed)
          return
        case 'paste-plain':
          pasteText().then((pasted) => {
            if (pasted !== '') insertAt(pasted.replace(/\r\n?/g, '\n'), range)
          }, failed)
          return
        case 'select-all': {
          element.focus()
          const all = document.createRange()
          all.selectNodeContents(element)
          selected?.removeAllRanges()
          selected?.addRange(all)
          return
        }
        case 'attach':
          picker.current?.click()
          return
        case 'clear':
          apply([], 0)
      }
    }
    const icons: Record<ComposerAction, MenuIcon> = {
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      'paste-plain': 'paste',
      'select-all': 'select',
      attach: 'attach',
      clear: 'close',
    }
    contextMenu.open(event, toSections(composerMenu({ hasSelection: text !== '', empty: current().length === 0, disabled }), run, icons))
  }

  return { onPaste, onContextMenu, contextMenu }
}
