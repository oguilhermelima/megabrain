import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { editableParts, messageCopyText, messageRoles, selectionCopyText, shareFileName } from '@/native-chat/message-actions'

const event = (id: string, kind: TranscriptEvent['kind'], text: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent => ({ id, at: null, kind, text, ...extra })
const message = (id: string, kind: TranscriptEvent['kind'], text: string, flags: { streaming?: boolean; pending?: boolean } = {}): NoticeDisplayItem => ({ type: 'message', event: event(id, kind, text), ...flags })
const tool = (id: string): NoticeDisplayItem => ({ type: 'tool-group', id, items: [] })

describe('messageCopyText', () => {
  test('the assistant as its markdown source', () => {
    expect(messageCopyText(event('a1', 'assistant', 'The tests pass: **12 of 12**.\n\n- `pnpm test`'))).toBe('The tests pass: **12 of 12**.\n\n- `pnpm test`')
  })

  test('the person as the plain text they typed, without image markers or parts', () => {
    expect(messageCopyText(event('u1', 'user', 'Look at [Image #1] and fix it'))).toBe('Look at and fix it')
    const withParts = event('u2', 'user', 'ignored', { parts: [{ type: 'text', text: 'Before ' }, { type: 'image', path: '/tmp/a.png' }, { type: 'text', text: 'after' }], images: [{ path: '/tmp/a.png' }] })
    expect(messageCopyText(withParts)).toBe('Before after')
  })
})

describe('selectionCopyText', () => {
  test('the messages in order, a blank line apart, the person quoted so the turns read apart', () => {
    const text = selectionCopyText([event('u1', 'user', 'Tidy the steps\nplease'), event('a1', 'assistant', 'Done: **5** files.'), event('u2', 'user', 'Thanks')])
    expect(text).toBe('> Tidy the steps\n> please\n\nDone: **5** files.\n\n> Thanks')
  })

  test('one message copies as messageCopyText does', () => {
    expect(selectionCopyText([event('u1', 'user', 'Hello')])).toBe('Hello')
  })
})

describe('messageRoles', () => {
  const rows = [
    message('a0', 'assistant', 'Welcome'),
    message('u1', 'user', 'Tidy'),
    message('a1', 'assistant', 'Looking'),
    tool('t1'),
    message('a2', 'assistant', 'Done'),
    message('u2', 'user', 'Thanks'),
    tool('t2'),
    message('a3', 'assistant', 'You are welcome'),
  ]

  test('the latest message of the person, and the last answer of each turn', () => {
    const roles = messageRoles(rows, false)
    expect(roles.lastPerson).toBe('u2')
    expect([...roles.turnEnds]).toEqual(['a0', 'a2', 'a3'])
  })

  test('while a turn runs nothing can be edited and the running turn has no end yet', () => {
    const roles = messageRoles(rows, true)
    expect(roles.lastPerson).toBe(null)
    expect([...roles.turnEnds]).toEqual(['a0', 'a2'])
  })

  test('a message still sending or streaming is no target', () => {
    const roles = messageRoles([message('u1', 'user', 'Tidy'), message('a1', 'assistant', 'Done'), message('u2', 'user', 'More', { pending: true })], false)
    expect(roles.lastPerson).toBe('u1')
    expect([...roles.turnEnds]).toEqual(['a1'])
  })

  test('the latest answer, whose actions always show, only once no turn runs and while nothing of the person follows it', () => {
    expect(messageRoles(rows, false).lastAnswer).toBe('a3')
    expect(messageRoles(rows, true).lastAnswer).toBe(null)
    expect(messageRoles([message('u1', 'user', 'Tidy'), message('a1', 'assistant', 'Done'), message('u2', 'user', 'More')], false).lastAnswer).toBe(null)
    expect(messageRoles([message('u1', 'user', 'Tidy')], false).lastAnswer).toBe(null)
  })

  test('no message of the person, nothing to edit', () => {
    expect(messageRoles([message('a1', 'assistant', 'Hi')], false).lastPerson).toBe(null)
  })
})

describe('editableParts', () => {
  test('the parts the message was sent with, images where they were', () => {
    const parts = [{ type: 'text' as const, text: 'See ' }, { type: 'image' as const, path: '/tmp/a.png' }]
    expect(editableParts(event('u1', 'user', 'See [Image #1]', { parts, images: [{ path: '/tmp/a.png' }] }))).toEqual(parts)
  })

  test('without parts: the text, then each image kept as a file; inline images cannot come back', () => {
    expect(editableParts(event('u1', 'user', 'Fix [Image #1]', { images: [{ path: '/tmp/a.png' }, { dataUrl: 'data:image/png;base64,AA' }] }))).toEqual([
      { type: 'text', text: 'Fix ' },
      { type: 'image', path: '/tmp/a.png' },
    ])
    expect(editableParts(event('u2', 'user', 'Plain'))).toEqual([{ type: 'text', text: 'Plain' }])
  })
})

describe('shareFileName', () => {
  test('the chat title as a file name, one or several messages', () => {
    expect(shareFileName('Tidy the onboarding steps', 1)).toBe('Tidy the onboarding steps.png')
    expect(shareFileName('Fix: a/b "quotes"', 3)).toBe('Fix a b quotes (3 messages).png')
    expect(shareFileName(null, 1)).toBe('Message.png')
  })
})
