import type { MessagePart } from '@/api/schema'

// Pure logic for a native chat's queue above the composer: what each queued message shows and where
// a keyboard reorder moves it.

/** The first line worth reading and the names of the images a queued message carries. */
export function queueSummary(parts: readonly MessagePart[]): { line: string; images: string[] } {
  const text = parts.map((part) => (part.type === 'text' ? part.text : '\n')).join('')
  const line = text.split('\n').map((value) => value.trim()).find((value) => value !== '') ?? ''
  const images = parts.flatMap((part) => (part.type === 'image' ? [part.path.split('/').at(-1) ?? part.path] : []))
  return { line, images }
}

/** The index Alt+ArrowUp or Alt+ArrowDown moves a message to; null at either end or for a message no longer queued. */
export function moveTarget(ids: readonly string[], id: string, direction: 'up' | 'down'): number | null {
  const index = ids.indexOf(id)
  if (index === -1) return null
  const target = direction === 'up' ? index - 1 : index + 1
  return target < 0 || target >= ids.length ? null : target
}

// The composer's walk through the queue. ArrowUp in an empty composer, caret at the start, takes the
// last queued message in for editing; while editing, ArrowUp at the start and ArrowDown at the end
// move to the earlier or later message, and ArrowDown past the last leaves the queue to an empty
// composer. Esc gives the message back unchanged; Enter saves it, and the queue moves it to its end.
// Moving to another message drops what was typed into this one: only Enter saves.

export interface QueueWalk {
  /** The queued message the composer holds for editing; null outside the queue. */
  editing: string | null
}

export const idleWalk: QueueWalk = { editing: null }

export interface WalkContext {
  /** The queue's message ids, oldest first. */
  ids: readonly string[]
  /** Nothing typed and nothing attached. */
  empty: boolean
  /** The caret, collapsed, sits at the start or at the end of the draft. */
  atStart: boolean
  atEnd: boolean
}

export type WalkEffect = { type: 'load'; id: string } | { type: 'clear' } | { type: 'save'; id: string } | null

export function walkKey(walk: QueueWalk, key: string, context: WalkContext): { walk: QueueWalk; effect: WalkEffect; handled: boolean } {
  const ignored = { walk, effect: null, handled: false }
  const { ids } = context
  if (walk.editing === null) {
    const last = ids.at(-1)
    if (key !== 'ArrowUp' || !context.empty || !context.atStart || last === undefined) return ignored
    return { walk: { editing: last }, effect: { type: 'load', id: last }, handled: true }
  }
  const index = ids.indexOf(walk.editing)
  if (index === -1) return ignored
  switch (key) {
    case 'ArrowUp': {
      if (!context.atStart) return ignored
      const previous = ids[index - 1]
      return previous === undefined ? { walk, effect: null, handled: true } : { walk: { editing: previous }, effect: { type: 'load', id: previous }, handled: true }
    }
    case 'ArrowDown': {
      if (!context.atEnd) return ignored
      const next = ids[index + 1]
      return next === undefined ? { walk: idleWalk, effect: { type: 'clear' }, handled: true } : { walk: { editing: next }, effect: { type: 'load', id: next }, handled: true }
    }
    case 'Escape':
      return { walk: idleWalk, effect: { type: 'clear' }, handled: true }
    case 'Enter':
      return { walk: idleWalk, effect: { type: 'save', id: walk.editing }, handled: true }
    default:
      return ignored
  }
}

/** A message that left the queue while being edited (its turn came) ends the walk; the draft stays as a new message. */
export function reconcileWalk(walk: QueueWalk, ids: readonly string[]): QueueWalk {
  return walk.editing !== null && !ids.includes(walk.editing) ? idleWalk : walk
}
