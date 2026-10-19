import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import { turnHeaderLabel, turnSpans } from '@/native-chat/turn-header'

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 19, 12, 0, seconds)).toISOString()
const ms = (seconds: number) => Date.parse(at(seconds))

function event(id: string, kind: TranscriptEvent['kind'], seconds: number | null, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: seconds === null ? null : at(seconds), kind, text: '', ...fields }
}

describe('turnSpans', () => {
  test('a turn runs from the person message to the last event before the next one', () => {
    const spans = turnSpans([event('u1', 'user', 0), event('a1', 'tool-call', 3), event('a2', 'assistant', 80), event('u2', 'user', 100), event('a3', 'assistant', 105)], false)
    expect(spans.get('u1')).toEqual({ start: ms(0), end: ms(80) })
    expect(spans.get('u2')).toEqual({ start: ms(100), end: ms(105) })
  })

  test('the last turn has no end while the chat works', () => {
    const spans = turnSpans([event('u1', 'user', 0), event('a1', 'tool-call', 3)], true)
    expect(spans.get('u1')).toEqual({ start: ms(0), end: null })
  })

  test('a running turn with no agent event yet still shows', () => {
    expect(turnSpans([event('u1', 'user', 0)], true).get('u1')).toEqual({ start: ms(0), end: null })
  })

  test('a settled turn the agent never answered has no header', () => {
    expect(turnSpans([event('u1', 'user', 0)], false).has('u1')).toBe(false)
  })

  test('only the last turn can be running', () => {
    const spans = turnSpans([event('u1', 'user', 0), event('a1', 'assistant', 9), event('u2', 'user', 20)], true)
    expect(spans.get('u1')).toEqual({ start: ms(0), end: ms(9) })
    expect(spans.get('u2')?.end).toBeNull()
  })

  test('relayed and subagent messages do not start a turn; events without a time are skipped', () => {
    const spans = turnSpans([event('u1', 'user', 0), event('r1', 'user', 5, { origin: { kind: 'parent', label: 'lead', dispatchId: null, sessionId: null } }), event('s1', 'user', 6, { parentId: 'sub' }), event('a1', 'assistant', null), event('a2', 'assistant', 7)], false)
    expect([...spans.keys()]).toEqual(['u1'])
    expect(spans.get('u1')).toEqual({ start: ms(0), end: ms(7) })
  })

  test('a person message without a time has no header', () => {
    expect(turnSpans([event('u1', 'user', null), event('a1', 'assistant', 3)], false).has('u1')).toBe(false)
  })
})

describe('turnHeaderLabel', () => {
  test('working while it runs, counting to now', () => {
    expect(turnHeaderLabel({ start: ms(0), end: null }, ms(9))).toBe('Working for 9s')
  })

  test('worked once it ended, frozen at the end', () => {
    expect(turnHeaderLabel({ start: ms(0), end: ms(80) }, ms(500))).toBe('Worked for 1m 20s')
  })

  test('never negative', () => {
    expect(turnHeaderLabel({ start: ms(10), end: null }, ms(0))).toBe('Working for 0s')
  })
})
