import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { emptySelection, selectableIds, selectedInOrder, toggleMessage } from '@/native-chat/message-selection'

const message = (id: string, kind: TranscriptEvent['kind'], text: string, flags: { streaming?: boolean; pending?: boolean } = {}): NoticeDisplayItem => ({ type: 'message', event: { id, at: null, kind, text }, ...flags })
const tool = (id: string): NoticeDisplayItem => ({ type: 'tool-group', id, items: [] })

describe('selectableIds', () => {
  test('the messages of the person and of the assistant, in transcript order; tools, thinking, system and live rows are not', () => {
    const rows = [
      message('u1', 'user', 'Tidy'),
      message('th1', 'thinking', 'plan'),
      tool('t1'),
      message('a1', 'assistant', 'Done'),
      message('s1', 'system', 'Session resumed'),
      message('u2', 'user', 'Thanks'),
      message('a2', 'assistant', 'Still writing', { streaming: true }),
      message('u3', 'user', 'Sending', { pending: true }),
    ]
    expect(selectableIds(rows)).toEqual(['u1', 'a1', 'u2'])
  })
})

describe('toggleMessage', () => {
  const order = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']

  test('a click adds a message, a second click takes it out', () => {
    const once = toggleMessage(emptySelection, 'a1', order, false)
    expect(once.ids).toEqual(['a1'])
    expect(toggleMessage(once, 'a1', order, false).ids).toEqual([])
  })

  test('a shift-click selects every message from the last one clicked to this one, either direction', () => {
    const anchored = toggleMessage(emptySelection, 'a1', order, false)
    expect(selectedInOrder(toggleMessage(anchored, 'u3', order, true), order)).toEqual(['a1', 'u2', 'a2', 'u3'])
    const back = toggleMessage(toggleMessage(emptySelection, 'a3', order, false), 'u2', order, true)
    expect(selectedInOrder(back, order)).toEqual(['u2', 'a2', 'u3', 'a3'])
  })

  test('a range adds to what was selected and keeps the anchor where it was', () => {
    let selection = toggleMessage(emptySelection, 'u1', order, false)
    selection = toggleMessage(selection, 'u2', order, false)
    selection = toggleMessage(selection, 'u3', order, true)
    expect(selectedInOrder(selection, order)).toEqual(['u1', 'u2', 'a2', 'u3'])
    expect(selection.anchor).toBe('u2')
  })

  test('a shift-click with nothing clicked before selects only that message', () => {
    expect(toggleMessage(emptySelection, 'a2', order, true).ids).toEqual(['a2'])
  })
})

describe('selectedInOrder', () => {
  test('the transcript order, whatever order they were clicked in; ids no longer shown drop out', () => {
    let selection = toggleMessage(emptySelection, 'a3', ['u1', 'a1', 'a3', 'gone'], false)
    selection = toggleMessage(selection, 'u1', ['u1', 'a1', 'a3', 'gone'], false)
    selection = toggleMessage(selection, 'gone', ['u1', 'a1', 'a3', 'gone'], false)
    expect(selectedInOrder(selection, ['u1', 'a1', 'a3'])).toEqual(['u1', 'a3'])
  })
})
