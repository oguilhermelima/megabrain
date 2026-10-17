/** Where the pointer was last seen during a drag. */
export interface DragPoint {
  clientX: number
  clientY: number
}

/**
 * Follows a press on a drag handle until it ends, however it ends. The pointer is captured, so a
 * release over an iframe (the Code tab's editor, an artifact) still reaches the page; losing the
 * capture, a cancel or the window losing focus end the drag too. Meanwhile the body shows `cursor`, and
 * the end always clears it: a release that never arrived used to leave the whole window showing a
 * resize cursor. `onEnd` gets the last point seen.
 */
export function trackDrag(press: { currentTarget: Element; pointerId: number; clientX: number; clientY: number }, cursor: string, onMove: (move: PointerEvent) => void, onEnd?: (last: DragPoint) => void) {
  const element = press.currentTarget
  const pointer = press.pointerId
  let last: DragPoint = { clientX: press.clientX, clientY: press.clientY }
  let ended = false
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    last = { clientX: event.clientX, clientY: event.clientY }
    onMove(event)
  }
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    last = { clientX: event.clientX, clientY: event.clientY }
    end()
  }
  const end = () => {
    if (ended) return
    ended = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', end)
    window.removeEventListener('blur', end)
    element.removeEventListener('lostpointercapture', end)
    if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer)
    document.body.style.cursor = ''
    onEnd?.(last)
  }
  try {
    element.setPointerCapture(pointer)
  } catch {
    // A pointer already gone cannot be captured; the window listeners still see the rest.
  }
  document.body.style.cursor = cursor
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
  element.addEventListener('lostpointercapture', end)
}
