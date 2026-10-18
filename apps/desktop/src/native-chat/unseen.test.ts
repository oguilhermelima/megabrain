import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'
import { lastSeenStoreKey, readLastSeen, unseenDivider, writeLastSeen } from '@/native-chat/unseen'

const opened = Date.parse('2026-10-18T12:00:00Z')
const before = '2026-10-18T11:00:00Z'
const after = '2026-10-18T12:05:00Z'

function event(id: string, kind: TranscriptEvent['kind'], at: string | null = before, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at, kind, text: id, ...fields }
}

const history = [event('u1', 'user'), event('a1', 'assistant'), event('t1', 'tool-call'), event('a2', 'assistant'), event('u2', 'user'), event('a3', 'assistant')]

describe('unseenDivider', () => {
  test('no divider on a chat never seen', () => {
    expect(unseenDivider(history, null, opened)).toBeNull()
  })

  test('above the first agent message after the last seen event', () => {
    expect(unseenDivider(history, 'a1', opened)).toBe('a2')
    expect(unseenDivider(history, 'u1', opened)).toBe('a1')
  })

  test('skips the person\'s own messages and tool rows to reach the agent', () => {
    expect(unseenDivider(history, 'a2', opened)).toBe('a3')
  })

  test('nothing newer than the last seen event: no divider', () => {
    expect(unseenDivider(history, 'a3', opened)).toBeNull()
  })

  test('a last seen event no longer in the transcript (rewound) shows no divider', () => {
    expect(unseenDivider(history, 'gone', opened)).toBeNull()
  })

  test('an answer written while the view is open is not unseen', () => {
    const live = history.concat(event('a4', 'assistant', after))
    expect(unseenDivider(live, 'a3', opened)).toBeNull()
  })

  test('stays in place while new events arrive', () => {
    const first = unseenDivider(history, 'a1', opened)
    const grown = history.concat(event('a4', 'assistant', after), event('a5', 'assistant'))
    expect(unseenDivider(grown, 'a1', opened)).toBe(first)
  })

  test('a subagent\'s message is not the chat\'s own answer', () => {
    const events = [event('a1', 'assistant'), event('s1', 'assistant', before, { parentId: 't1' }), event('a2', 'assistant')]
    expect(unseenDivider(events, 'a1', opened)).toBe('a2')
  })

  test('an answer with no time counts as unseen', () => {
    expect(unseenDivider([event('a1', 'assistant'), event('a2', 'assistant', null)], 'a1', opened)).toBe('a2')
  })
})

function memory(initial: Record<string, string> = {}): WidthStorage & { values: Record<string, string> } {
  const values = { ...initial }
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) }
}

const throwing: WidthStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('last seen storage', () => {
  test('a chat never seen reads null', () => {
    expect(readLastSeen(() => memory(), 'chat-1')).toBeNull()
  })

  test('remembers each chat\'s last seen event apart', () => {
    const store = memory()
    writeLastSeen(() => store, 'chat-1', 'e1')
    writeLastSeen(() => store, 'chat-2', 'e9')
    writeLastSeen(() => store, 'chat-1', 'e2')
    expect(readLastSeen(() => store, 'chat-1')).toBe('e2')
    expect(readLastSeen(() => store, 'chat-2')).toBe('e9')
  })

  test('something else under the key reads null', () => {
    expect(readLastSeen(() => memory({ [lastSeenStoreKey]: '{"chat-1": 4}' }), 'chat-1')).toBeNull()
    expect(readLastSeen(() => memory({ [lastSeenStoreKey]: 'not json' }), 'chat-1')).toBeNull()
  })

  test('blocked storage reads null and forgets quietly', () => {
    expect(readLastSeen(() => throwing, 'chat-1')).toBeNull()
    expect(() => writeLastSeen(() => throwing, 'chat-1', 'e1')).not.toThrow()
  })
})
