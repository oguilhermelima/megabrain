import { describe, expect, test } from 'bun:test'
import { idleWalk, moveTarget, queueRows, queueSummary, reconcileWalk, walkKey, type WalkContext } from '@/chat/queue-walk'

// The composer's walk through a native chat's queue: ArrowUp in an empty composer takes the last
// queued message for editing, the arrows move between messages, Esc gives up and Enter saves.

const ids = ['a', 'b', 'c']
const empty: WalkContext = { ids, empty: true, atStart: true, atEnd: true }
const typed: WalkContext = { ids, empty: false, atStart: true, atEnd: true }

describe('walkKey', () => {
  test('ArrowUp in an empty composer with the caret at the start enters the queue at its last message', () => {
    expect(walkKey(idleWalk, 'ArrowUp', empty)).toEqual({ walk: { editing: 'c' }, effect: { type: 'load', id: 'c' }, handled: true })
  })

  test('ArrowUp leaves the composer alone when it holds text, when the queue is empty, or with the caret past the start', () => {
    expect(walkKey(idleWalk, 'ArrowUp', typed).handled).toBe(false)
    expect(walkKey(idleWalk, 'ArrowUp', { ...empty, ids: [] }).handled).toBe(false)
    expect(walkKey(idleWalk, 'ArrowUp', { ...empty, atStart: false }).handled).toBe(false)
    expect(walkKey(idleWalk, 'ArrowDown', empty).handled).toBe(false)
    expect(walkKey(idleWalk, 'Escape', empty).handled).toBe(false)
    expect(walkKey(idleWalk, 'Enter', typed).handled).toBe(false)
  })

  test('while editing, ArrowUp at the start goes to the earlier message and stops at the first', () => {
    expect(walkKey({ editing: 'c' }, 'ArrowUp', typed)).toEqual({ walk: { editing: 'b' }, effect: { type: 'load', id: 'b' }, handled: true })
    expect(walkKey({ editing: 'a' }, 'ArrowUp', typed)).toEqual({ walk: { editing: 'a' }, effect: null, handled: true })
  })

  test('while editing, ArrowDown at the end goes to the later message, and past the last leaves the queue to an empty composer', () => {
    expect(walkKey({ editing: 'a' }, 'ArrowDown', typed)).toEqual({ walk: { editing: 'b' }, effect: { type: 'load', id: 'b' }, handled: true })
    expect(walkKey({ editing: 'c' }, 'ArrowDown', typed)).toEqual({ walk: idleWalk, effect: { type: 'clear' }, handled: true })
  })

  test('the arrows move the caret inside a message until it reaches the edge', () => {
    expect(walkKey({ editing: 'b' }, 'ArrowUp', { ...typed, atStart: false }).handled).toBe(false)
    expect(walkKey({ editing: 'b' }, 'ArrowDown', { ...typed, atEnd: false }).handled).toBe(false)
  })

  test('Esc cancels the edit and leaves the message as it was', () => {
    expect(walkKey({ editing: 'b' }, 'Escape', typed)).toEqual({ walk: idleWalk, effect: { type: 'clear' }, handled: true })
  })

  test('Enter saves the edit, which the queue moves to its end, and empties the composer', () => {
    expect(walkKey({ editing: 'a' }, 'Enter', typed)).toEqual({ walk: idleWalk, effect: { type: 'save', id: 'a' }, handled: true })
  })
})

describe('reconcileWalk', () => {
  test('keeps the edit while its message waits', () => {
    expect(reconcileWalk({ editing: 'b' }, ids)).toEqual({ editing: 'b' })
  })

  test('drops the edit when its message left the queue, so Enter sends the draft as a new message', () => {
    expect(reconcileWalk({ editing: 'b' }, ['a', 'c'])).toEqual(idleWalk)
    expect(walkKey(reconcileWalk({ editing: 'b' }, ['a', 'c']), 'Enter', typed).handled).toBe(false)
  })
})

describe('moveTarget', () => {
  test('Alt+ArrowUp and Alt+ArrowDown move a message by one place, and not past either end', () => {
    expect(moveTarget(ids, 'b', 'up')).toBe(0)
    expect(moveTarget(ids, 'b', 'down')).toBe(2)
    expect(moveTarget(ids, 'a', 'up')).toBeNull()
    expect(moveTarget(ids, 'c', 'down')).toBeNull()
    expect(moveTarget(ids, 'z', 'up')).toBeNull()
  })
})

describe('queueSummary', () => {
  test('shows the first non-empty line and counts the images', () => {
    expect(
      queueSummary([
        { type: 'text', text: '\n  fix the build\nthen ship' },
        { type: 'image', path: '/tmp/a.png' },
        { type: 'image', path: '/tmp/b.png' },
      ]),
    ).toEqual({ line: 'fix the build', images: ['a.png', 'b.png'] })
  })

  test('a message of images alone says so', () => {
    expect(queueSummary([{ type: 'image', path: '/tmp/shot.png' }])).toEqual({ line: '', images: ['shot.png'] })
  })
})

describe('queueRows', () => {
  const item = (id: string, parts: Parameters<typeof queueSummary>[0]) => ({ id, parts, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' })

  test('keeps send order, marks the first as next and numbers the rest', () => {
    const rows = queueRows([item('a', [{ type: 'text', text: 'one' }]), item('b', [{ type: 'text', text: 'two' }]), item('c', [{ type: 'text', text: 'three' }])])
    expect(rows.map((row) => [row.id, row.position, row.next])).toEqual([
      ['a', 1, true],
      ['b', 2, false],
      ['c', 3, false],
    ])
  })

  test('shows the whole text with its line breaks, trimmed, and the images', () => {
    const [row] = queueRows([item('a', [{ type: 'text', text: '\n  fix the build\nthen ship  \n' }, { type: 'image', path: '/tmp/a.png' }])])
    expect(row?.text).toBe('fix the build\nthen ship')
    expect(row?.images).toEqual(['a.png'])
  })

  test('a message of images alone has no text', () => {
    expect(queueRows([item('a', [{ type: 'image', path: '/tmp/shot.png' }])])[0]?.text).toBe('')
  })

  test('an empty queue has no rows', () => {
    expect(queueRows([])).toEqual([])
  })
})
