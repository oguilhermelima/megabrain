import { useEffect, useRef, type Dispatch, type DragEvent, type MouseEvent, type PointerEvent, type RefObject, type SetStateAction } from 'react'
import type { LightboxImage } from '@/chat/Lightbox'
import { deleteRange, moveToken, tokenIds, tokenOffset, type Draft } from '@/chat/composer-parts'
import { caretRect, offsetAtPoint, tokenAt } from '@/chat/rich-input'
import { fromFile, previewOf, type Attachment } from '@/chat/ComposerSupport'

export function useAttachmentInteractions({ editor, frame, disabled, current, apply, attach, attachments, hover, setHover, setPreview, setDropCaret }: {
  editor: RefObject<HTMLDivElement | null>
  frame: RefObject<HTMLDivElement | null>
  disabled: boolean
  current: () => Draft
  apply: (next: Draft, offset: number) => void
  attach: (added: (Attachment | null)[], at?: [number, number]) => void
  attachments: Map<string, Attachment>
  hover: { id: string; left: number; top: number } | null
  setHover: Dispatch<SetStateAction<{ id: string; left: number; top: number } | null>>
  setPreview: Dispatch<SetStateAction<{ images: LightboxImage[]; start: number } | null>>
  setDropCaret: Dispatch<SetStateAction<{ left: number; top: number; height: number } | null>>
}) {
  const removeToken = (id: string) => {
    setHover(null)
    const draftNow = current()
    const offset = tokenOffset(draftNow, id)
    if (offset !== null) apply(deleteRange(draftNow, offset, offset + 1), offset)
  }

  // A chip moves with pointer events rather than a native drag: in the app's webview a native drag
  // is taken by the window's own file drop, so it never reached the box as a move.
  const drag = useRef<{ id: string; x: number; y: number; moving: boolean } | null>(null)
  const justDragged = useRef(false)

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (justDragged.current) return
    const element = editor.current
    const token = element === null ? null : tokenAt(event.target, element)
    const id = token?.dataset.token
    if (id === undefined) return
    if (event.target instanceof HTMLElement && event.target.closest('[data-remove]') !== null) {
      removeToken(id)
      return
    }
    // The message's images in order, opened at the one clicked.
    const images = tokenIds(current()).flatMap((tokenId) => {
      const attachment = attachments.get(tokenId)
      const src = attachment === undefined ? null : previewOf(attachment)
      return attachment === undefined || src === null ? [] : [{ id: tokenId, src, name: attachment.name }]
    })
    const start = images.findIndex((image) => image.id === id)
    if (start >= 0) setPreview({ images, start })
  }

  const showDropCaret = (offset: number | null) => {
    const element = editor.current
    const box = frame.current
    const rect = element === null || offset === null ? null : caretRect(element, offset)
    if (rect === null || box === null) {
      setDropCaret(null)
      return
    }
    const origin = box.getBoundingClientRect()
    setDropCaret({ left: rect.left - origin.left, top: rect.top - origin.top, height: rect.height })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = editor.current
    if (event.button !== 0 || disabled || element === null || !(event.target instanceof HTMLElement) || event.target.closest('[data-remove]') !== null) return
    const id = tokenAt(event.target, element)?.dataset.token
    if (id === undefined) return
    // No caret, selection or native drag starts from a chip.
    event.preventDefault()
    drag.current = { id, x: event.clientX, y: event.clientY, moving: false }
  }

  const dragging = (id: string, on: boolean) => {
    const chip = editor.current?.querySelector<HTMLElement>(`[data-token="${id}"]`)
    if (chip === null || chip === undefined) return
    if (on) chip.dataset.dragging = ''
    else delete chip.dataset.dragging
  }

  const pointer = useRef({ move: (_event: globalThis.PointerEvent) => {}, end: (_event: globalThis.PointerEvent | null) => {} })
  pointer.current.move = (event) => {
    const state = drag.current
    if (state === null) return
    if (!state.moving) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return
      state.moving = true
      setHover(null)
      dragging(state.id, true)
    }
    showDropCaret(editor.current === null ? null : offsetAtPoint(editor.current, event.clientX, event.clientY))
  }
  pointer.current.end = (event) => {
    const state = drag.current
    drag.current = null
    if (state === null || !state.moving) return
    dragging(state.id, false)
    setDropCaret(null)
    // The click that ends a drag does not open the image.
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 0)
    const element = editor.current
    const at = event === null || element === null ? null : offsetAtPoint(element, event.clientX, event.clientY)
    if (at === null) return
    const next = moveToken(current(), state.id, at)
    apply(next, (tokenOffset(next, state.id) ?? 0) + 1)
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => pointer.current.move(event)
    const up = (event: globalThis.PointerEvent) => pointer.current.end(event)
    const cancel = () => pointer.current.end(null)
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || drag.current?.moving !== true) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  /** The image under the pointer shows above its chip. */
  const onHover = (event: PointerEvent<HTMLDivElement>) => {
    const element = editor.current
    const chip = element === null || drag.current !== null ? null : tokenAt(event.target, element)
    const id = chip?.dataset.token
    if (chip === null || chip === undefined || id === undefined) {
      if (hover !== null) setHover(null)
      return
    }
    if (hover?.id === id) return
    const box = chip.getBoundingClientRect()
    setHover({ id, left: box.left, top: box.top })
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    showDropCaret(editor.current === null ? null : offsetAtPoint(editor.current, event.clientX, event.clientY))
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || frame.current?.contains(event.relatedTarget) !== true) setDropCaret(null)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropCaret(null)
    const element = editor.current
    const at = element === null ? null : offsetAtPoint(element, event.clientX, event.clientY)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    attach(files.map(fromFile), at === null ? undefined : [at, at])
  }

  return { onClick, onPointerDown, onHover, onDragOver, onDragLeave, onDrop, removeToken }
}
