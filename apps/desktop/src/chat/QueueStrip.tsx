import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ChatQueueItem } from '@/api/schema'
import { moveTarget, queueSummary } from '@/chat/queue-walk'

/** What the composer offers on a native chat's queue; the view owns the calls and the confirm before Send now. */
export interface QueueControls {
  items: ChatQueueItem[]
  edit: (itemId: string, parts: ChatQueueItem['parts']) => Promise<void>
  move: (itemId: string, to: number) => Promise<void>
  remove: (itemId: string) => Promise<void>
  sendNow: (itemId: string) => void
  /** Set while a Codex turn runs: puts the message into that turn instead of waiting for it to end. */
  steer?: (itemId: string) => Promise<void>
}

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none'
const textButton = 'shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink-200 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none'

/**
 * The messages waiting for the running turn to end, oldest first, above the composer. Each can be
 * dragged by its handle or moved with Alt+ArrowUp/Down, taken into the composer to edit, or removed;
 * the first can be sent now, which stops the turn.
 */
export function QueueStrip({ queue, editing, onEdit }: { queue: QueueControls; editing: string | null; onEdit: (item: ChatQueueItem) => void }) {
  const { items } = queue
  const rows = useRef(new Map<string, HTMLLIElement>())
  // A drag moves with pointer events: in the app's webview a native drag is taken by the window's file drop.
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag
  useEffect(() => {
    if (drag !== null && !items.some((item) => item.id === drag.id)) setDrag(null)
  }, [items, drag])
  if (items.length === 0) return null
  const ids = items.map((item) => item.id)

  // Where the dragged message lands: after every other message whose middle is above the pointer.
  const indexAt = (y: number, dragged: string) =>
    ids.filter((id) => {
      const box = id === dragged ? undefined : rows.current.get(id)?.getBoundingClientRect()
      return box !== undefined && y > box.top + box.height / 2
    }).length
  // While dragging, the list shows the order the drop would leave.
  const shown = drag === null ? items : (() => {
    const rest = items.filter((item) => item.id !== drag.id)
    const moving = items.find((item) => item.id === drag.id)
    return moving === undefined ? items : [...rest.slice(0, drag.over), moving, ...rest.slice(drag.over)]
  })()

  const onHandleDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ id, over: ids.indexOf(id) })
  }
  const onHandleMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current === null) return
    const over = indexAt(event.clientY, dragRef.current.id)
    if (over !== dragRef.current.over) setDrag({ ...dragRef.current, over })
  }
  const onHandleUp = () => {
    const state = dragRef.current
    setDrag(null)
    if (state !== null && state.over !== ids.indexOf(state.id)) void queue.move(state.id, state.over)
  }

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const to = moveTarget(ids, id, event.key === 'ArrowUp' ? 'up' : 'down')
    if (to === null) return
    void queue.move(id, to).then(() => rows.current.get(id)?.focus())
  }

  return (
    <ol aria-label="Queued messages" className="mb-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto px-1">
      {shown.map((item, index) => {
        const { line, images } = queueSummary(item.parts)
        const isEditing = item.id === editing
        const dragging = drag?.id === item.id
        return (
          <li
            key={item.id}
            ref={(element) => {
              if (element === null) rows.current.delete(item.id)
              else rows.current.set(item.id, element)
            }}
            tabIndex={0}
            onKeyDown={(event) => onRowKey(event, item.id)}
            aria-label={`Queued message ${index + 1}${isEditing ? ', editing' : ''}: ${line || `${images.length} image${images.length === 1 ? '' : 's'}`}. Alt+Arrow keys reorder.`}
            className={`group flex min-w-0 items-center gap-1.5 rounded-[12px] border py-0.5 pr-1 pl-0.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 ${
              isEditing ? 'border-accent/40 bg-accent/[0.08]' : 'border-white/[0.07] bg-white/[0.03]'
            } ${dragging ? 'ring-1 ring-accent/40' : ''}`}
          >
            <button
              type="button"
              aria-label="Drag to reorder"
              title="Drag to reorder (Alt+↑/↓)"
              onPointerDown={(event) => onHandleDown(event, item.id)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={() => setDrag(null)}
              className={`${iconButton} cursor-grab touch-none active:cursor-grabbing`}
            >
              <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true">
                <circle cx="6" cy="4" r="1.1" />
                <circle cx="10" cy="4" r="1.1" />
                <circle cx="6" cy="8" r="1.1" />
                <circle cx="10" cy="8" r="1.1" />
                <circle cx="6" cy="12" r="1.1" />
                <circle cx="10" cy="12" r="1.1" />
              </svg>
            </button>
            <span className="w-4 shrink-0 text-right text-[11.5px] text-ink-500 tabular-nums">{index + 1}</span>
            <span className={`min-w-0 flex-1 truncate ${line === '' ? 'text-ink-400' : 'text-ink-200'}`} title={line}>
              {line === '' ? 'Images only' : line}
            </span>
            {images.map((name, position) => (
              <span key={`${name}-${position}`} title={name} className="max-w-24 shrink-0 truncate rounded-full border border-white/[0.08] bg-white/[0.05] px-1.5 text-[11px] text-ink-300">
                {name}
              </span>
            ))}
            {isEditing && <span className="shrink-0 px-1 text-[11.5px] font-medium text-accent">Editing</span>}
            {queue.steer !== undefined && (
              <button type="button" onClick={() => void queue.steer?.(item.id)} title="Put this message into the running turn" className={textButton}>
                Steer
              </button>
            )}
            {index === 0 && (
              <button type="button" onClick={() => queue.sendNow(item.id)} title="Stop the running turn and send this message now" className={textButton}>
                Send now
              </button>
            )}
            <button type="button" onClick={() => onEdit(item)} disabled={isEditing} aria-label="Edit" title="Edit in the composer" className={`${iconButton} disabled:opacity-40`}>
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.5 3.5 12.5 5.5M3 13l.6-2.6L10.5 3.5l2 2-6.9 6.9z" />
              </svg>
            </button>
            <button type="button" onClick={() => void queue.remove(item.id)} aria-label="Remove" title="Remove from the queue" className={iconButton}>
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
