import { describe, expect, test } from 'bun:test'
import type { ChatEventLine, TranscriptEvent } from '@/api/schema'
import { editLastMockChat, forkMockChat, mockLongChat, readMockChat } from '@/api/fixtures/chat'
import { applyLine, followState, rewindEvents } from '@/native-chat/chat-model'

const event = (id: string, kind: TranscriptEvent['kind'], text: string): TranscriptEvent => ({ id, at: null, kind, text })
const line = (cursor: number, value: TranscriptEvent): ChatEventLine => ({ cursor: String(cursor), event: value })
const fold = (lines: ChatEventLine[]) => lines.reduce(applyLine, followState(null))
const history = [line(1, event('u1', 'user', 'Tidy')), line(2, event('a1', 'assistant', 'Done')), line(3, event('u2', 'user', 'Rename')), line(4, event('a2', 'assistant', 'Renamed'))]

describe('the rewind an edit of the last message leaves', () => {
  test('a rewind line drops every event from the one it names onward, and moves the cursor', () => {
    const state = fold([...history, { cursor: '5', event: { kind: 'rewind', fromEventId: 'u2', at: null } }])
    expect(state.events.map((known) => known.id)).toEqual(['u1', 'a1'])
    expect(state.cursor).toBe('5')
  })

  test('the new message after the rewind shows in the old one\'s place, also on a replay from the start', () => {
    const lines = [...history, { cursor: '5', event: { kind: 'rewind' as const, fromEventId: 'u2', at: null } }, line(6, event('u3', 'user', 'Rename the files')), line(7, event('a3', 'assistant', 'Renamed the files'))]
    expect(fold(lines).events.map((known) => known.id)).toEqual(['u1', 'a1', 'u3', 'a3'])
  })

  test('dropping the events at once, before the rewind line arrives, leaves the same transcript when it does', () => {
    const early = rewindEvents(fold(history), 'u2')
    expect(early.events.map((known) => known.id)).toEqual(['u1', 'a1'])
    const late = applyLine(early, { cursor: '5', event: { kind: 'rewind', fromEventId: 'u2', at: null } })
    expect(late.events.map((known) => known.id)).toEqual(['u1', 'a1'])
  })

  test('a rewind naming an event the view never had changes nothing but the cursor', () => {
    const state = fold([...history, { cursor: '5', event: { kind: 'rewind', fromEventId: 'nope', at: null } }])
    expect(state.events).toHaveLength(4)
  })
})

const shown = (chatId: string) => readMockChat(chatId, null).reduce(applyLine, followState(null)).events

describe('the mock CLI: chat fork and chat edit-last', () => {
  test('a fork holds the source up to and including the turn of the event, under a new id and a branch title', () => {
    const fork = forkMockChat(mockLongChat.id, 'long-u2')
    expect(fork.id).not.toBe(mockLongChat.id)
    expect(fork.title).toBe('Plan the release notes (branch)')
    expect(fork.agent).toBe(mockLongChat.agent)
    expect(fork.cwd).toBe(mockLongChat.cwd)
    expect(shown(fork.id).map((known) => known.id)).toEqual(['long-u1', 'long-a1', 'long-u2', 'long-a2'])
    // The source is untouched.
    expect(shown(mockLongChat.id)).toHaveLength(200)
  })

  test('a fork from the answer of a turn holds that same turn', () => {
    expect(shown(forkMockChat(mockLongChat.id, 'long-a3').id).map((known) => known.id).at(-1)).toBe('long-a3')
  })

  test('an edit of the last message rewinds its turn out and sends the new parts in its place', async () => {
    const fork = forkMockChat(mockLongChat.id, 'long-a2')
    editLastMockChat(fork.id, [{ type: 'text', text: 'Turn 2, edited' }])
    await new Promise((resolve) => setTimeout(resolve, 50))
    const ids = shown(fork.id)
    expect(ids.slice(0, 2).map((known) => known.id)).toEqual(['long-u1', 'long-a1'])
    expect(ids[2]?.kind).toBe('user')
    expect(ids[2]?.text).toBe('Turn 2, edited')
    expect(ids.some((known) => known.id === 'long-u2' || known.id === 'long-a2')).toBe(false)
  })

  test('refused while a turn runs, and with no message of the person to edit', () => {
    const fork = forkMockChat(mockLongChat.id, 'long-a1')
    editLastMockChat(fork.id, [{ type: 'text', text: 'first edit' }])
    expect(() => editLastMockChat(fork.id, [{ type: 'text', text: 'second edit' }])).toThrow(/chat-busy/)
    expect(() => editLastMockChat('chat-with-nothing-said', [{ type: 'text', text: 'edit' }])).toThrow(/nothing-to-edit/)
  })

  test('a fork from an event the chat does not have is refused', () => {
    expect(() => forkMockChat(mockLongChat.id, 'no-such-event')).toThrow()
  })
})
