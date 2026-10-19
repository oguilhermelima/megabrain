import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ChatQueueItem } from '@/api/schema'
import { moveTarget, queueRows } from '@/chat/queue-walk'
import { Tooltip } from '@/components/Tooltip'

/** What the composer offers on a native chat's queue; the view owns the calls and the confirm before Send now. */
export interface QueueControls {
  items: ChatQueueItem[]
  /** 'taken' when chatd had already sent the message: the edit did not apply and the composer keeps the text. */
  edit: (itemId: string, parts: ChatQueueItem['parts']) => Promise<'saved' | 'taken'>
  move: (itemId: string, to: number) => Promise<void>
  remove: (itemId: string) => Promise<void>
  /** Absent while a turn runs on an agent that cannot be interrupted, since sending now stops that turn first. */
  sendNow?: (itemId: string) => void
  /** Set while a turn runs on an agent that takes steering (Codex): puts the message into that turn instead of waiting for it to end. */
  steer?: (itemId: string) => Promise<void>
}

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none'
const textButton = 'shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink-200 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none'

/**
 * The messages waiting for the running turn to end, as an open queue above the composer: in send
 * order on one line, the next to go out marked. Each can be dragged by its handle or moved with its
 * buttons or Alt+ArrowUp/Down, taken into the composer to edit, or removed; the first can be sent
 * now, which stops the turn.
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

  const move = (id: string, direction: 'up' | 'down') => {
    const to = moveTarget(ids, id, direction)
    if (to !== null) void queue.move(id, to).then(() => rows.current.get(id)?.focus())
  }

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, id: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    move(id, event.key === 'ArrowUp' ? 'up' : 'down')
  }

  return (
    <section aria-label="Queue" className="mb-1.5">
      <div className="flex h-6 items-center gap-1.5 px-1 text-chat-small">
        <span className="font-medium text-ink-200">Queue</span>
        <span className="rounded-full bg-white/[0.06] px-1.5 text-[11px] font-medium text-ink-300 tabular-nums">{items.length}</span>
        <span className="min-w-0 truncate text-chat-label text-ink-400">sends when the turn ends</span>
      </div>
      {/* About five messages show; a longer queue scrolls inside the block so the composer stays put. */}
      <ol className="-mx-1 flex max-h-[15.5rem] flex-col overflow-y-auto px-1">
        {queueRows(shown).map((row, index) => {
          const item = shown[index]
          if (item === undefined) return null
          const isEditing = item.id === editing
          const dragging = drag?.id === item.id
          const last = index === shown.length - 1
          return (
            <li
              key={row.id}
              ref={(element) => {
                if (element === null) rows.current.delete(row.id)
                else rows.current.set(row.id, element)
              }}
              tabIndex={0}
              onKeyDown={(event) => onRowKey(event, row.id)}
              aria-label={`${row.next ? 'Next' : `Queued message ${row.position}`}${isEditing ? ', editing' : ''}: ${row.text || `${row.images.length} image${row.images.length === 1 ? '' : 's'}`}. Alt+Arrow keys reorder.`}
              className={`group relative flex min-w-0 gap-2 rounded-[12px] py-1 pr-1 pl-1 text-[12.5px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 ${
                isEditing ? 'bg-accent/[0.08]' : row.next ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'
              } ${dragging ? 'ring-1 ring-accent/40' : ''}`}
            >
              {/* The line joining the messages, from this marker down to the next one. */}
              {!last && <span aria-hidden="true" className="pointer-events-none absolute top-6 -bottom-1 left-[13px] w-px bg-white/[0.1]" />}
              <span
                aria-hidden="true"
                className={`relative z-10 mt-px grid size-[18px] shrink-0 place-items-center rounded-full text-[10.5px] font-medium tabular-nums ${
                  row.next ? 'bg-accent/20 text-accent ring-1 ring-accent/40' : 'bg-ink-900 text-ink-400 ring-1 ring-white/[0.12]'
                }`}
              >
                {row.position}
              </span>
              <div className="min-w-0 flex-1">
                {row.next && <span className="mb-0.5 block text-[11px] font-medium text-accent">Next</span>}
                <Tooltip text={row.text}>
                  {(tip) => (
                    <p {...tip} className={`line-clamp-2 break-words whitespace-pre-line ${row.text === '' ? 'text-ink-400' : row.next ? 'text-ink-100' : 'text-ink-300'}`}>
                      {row.text === '' ? 'Images only' : row.text}
                    </p>
                  )}
                </Tooltip>
                {(row.images.length > 0 || isEditing) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {row.images.map((name, position) => (
                      <Tooltip key={`${name}-${position}`} text={name}>
                        {(tip) => (
                          <span {...tip} className="max-w-24 truncate rounded-full border border-white/[0.08] bg-white/[0.05] px-1.5 text-[11px] text-ink-300">
                            {name}
                          </span>
                        )}
                      </Tooltip>
                    ))}
                    {isEditing && <span className="px-1 text-[11.5px] font-medium text-accent">Editing</span>}
                  </div>
                )}
              </div>
              {/* Shown on hover or while any control in the row has the focus, so every action stays reachable by keyboard. */}
              <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                {queue.steer !== undefined && (
                  <Tooltip text="Put this message into the running turn">
                    {(tip) => (
                      <button type="button" {...tip} onClick={() => void queue.steer?.(row.id)} className={textButton}>
                        Steer
                      </button>
                    )}
                  </Tooltip>
                )}
                {row.next && queue.sendNow !== undefined && (
                  <Tooltip text="Stop the running turn and send this message now">
                    {(tip) => (
                      <button type="button" {...tip} onClick={() => queue.sendNow?.(row.id)} className={textButton}>
                        Send now
                      </button>
                    )}
                  </Tooltip>
                )}
                <Tooltip text="Move up (Alt+↑)">
                  {(tip) => (
                    <button type="button" {...tip} onClick={() => move(row.id, 'up')} disabled={index === 0} aria-label="Move up" className={`${iconButton} disabled:opacity-40`}>
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m5 9.5 3-3 3 3" />
                      </svg>
                    </button>
                  )}
                </Tooltip>
                <Tooltip text="Move down (Alt+↓)">
                  {(tip) => (
                    <button type="button" {...tip} onClick={() => move(row.id, 'down')} disabled={last} aria-label="Move down" className={`${iconButton} disabled:opacity-40`}>
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m5 6.5 3 3 3-3" />
                      </svg>
                    </button>
                  )}
                </Tooltip>
                <Tooltip text="Edit in the composer">
                  {(tip) => (
                    <button type="button" {...tip} onClick={() => onEdit(item)} disabled={isEditing} aria-label="Edit" className={`${iconButton} disabled:opacity-40`}>
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10.5 3.5 12.5 5.5M3 13l.6-2.6L10.5 3.5l2 2-6.9 6.9z" />
                      </svg>
                    </button>
                  )}
                </Tooltip>
                <Tooltip text="Remove from the queue">
                  {(tip) => (
                    <button type="button" {...tip} onClick={() => void queue.remove(row.id)} aria-label="Remove" className={iconButton}>
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  )}
                </Tooltip>
                <Tooltip text="Drag to reorder (Alt+↑/↓)">
                  {(tip) => (
                    <button
                      type="button"
                      aria-label="Drag to reorder"
                      {...tip}
                      onPointerDown={(event) => onHandleDown(event, row.id)}
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
                  )}
                </Tooltip>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
