import { describe, expect, test } from 'bun:test'
import { mockTranscript } from '@/api/fixtures/mock'
import type { TranscriptEvent } from '@/api/schema'
import { deriveConversation, type DerivedConversation } from '@/chat/conversation-derive'
import { buildConversationItems, mergeEvents } from '@/chat/conversation-model'
import { groupToolRuns } from '@/chat/tool-groups'

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: id, ...fields }
}
const user = (id: string) => event(id, { kind: 'user' })
const thinking = (id: string) => event(id, { kind: 'thinking' })
const system = (id: string) => event(id, { kind: 'system' })
const relayed = (id: string) => event(id, { kind: 'thinking', origin: { kind: 'child', label: 'child', dispatchId: 'd', sessionId: null } })
const call = (id: string, name = 'Bash') => event(id, { kind: 'tool-call', text: name, tool: { name, input: '{}' } })
const result = (id: string, status: 'ok' | 'error' = 'ok') => event(id, { kind: 'tool-result', text: 'out', tool: { name: 'x', status } })

const fixtures: Record<string, TranscriptEvent[]> = {
  plain: [user('u1'), event('a1'), user('u2'), event('a2')],
  'one tool run': [user('u1'), call('c1'), result('r1'), call('c2', 'Read'), result('r2'), event('a1')],
  'thinking inside and after a run': [call('c1'), result('r1'), thinking('t1'), call('c2'), result('r2'), thinking('t2'), thinking('t3'), event('a1'), thinking('t4')],
  'a run still going at the end': [user('u1'), call('c1'), result('r1'), call('c2')],
  'a call whose result never came': [call('c1'), call('c2'), result('r2', 'error'), event('a1'), call('c3')],
  'relayed and system messages end runs': [call('c1'), result('r1'), relayed('x1'), call('c2'), system('s1'), call('c3'), result('r3')],
  'a stray result': [result('r0'), user('u1'), result('r1'), call('c1'), result('r2'), result('r3')],
  'the mock transcript': mockTranscript.events,
}

const full = (events: TranscriptEvent[]) => groupToolRuns(buildConversationItems(events))

/** Every way of cutting the events into polls of at most `size`, plus a seeded random cut. */
function batchings(events: TranscriptEvent[]): TranscriptEvent[][][] {
  const cuts: TranscriptEvent[][][] = []
  for (let size = 1; size <= Math.max(events.length, 1); size++) {
    const batches: TranscriptEvent[][] = []
    for (let index = 0; index < events.length; index += size) batches.push(events.slice(index, index + size))
    cuts.push(batches)
  }
  let seed = 7
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  for (let round = 0; round < 20; round++) {
    const batches: TranscriptEvent[][] = []
    let index = 0
    while (index < events.length) {
      const size = Math.floor(random() * 4)
      batches.push(events.slice(index, index + size))
      index += size
    }
    cuts.push(batches)
  }
  return cuts
}

describe('deriveConversation', () => {
  for (const [name, events] of Object.entries(fixtures)) {
    test(`polled in any batches, it equals the full derivation: ${name}`, () => {
      for (const batches of batchings(events)) {
        let known: TranscriptEvent[] = []
        let derived: DerivedConversation | null = null
        for (const batch of batches) {
          known = mergeEvents(known, batch)
          derived = deriveConversation(derived, known)
          expect(derived.display).toEqual(full(known))
        }
      }
    })
  }

  test('a repeated poll that brought nothing new keeps the same display', () => {
    const events = fixtures['one tool run'] ?? []
    const first = deriveConversation(null, events)
    expect(deriveConversation(first, mergeEvents(events, [])).display).toBe(first.display)
  })

  test('settled items keep their identity when new events arrive', () => {
    const events = [user('u1'), event('a1'), call('c1'), result('r1'), event('a2')]
    const first = deriveConversation(null, events)
    const second = deriveConversation(first, mergeEvents(events, [user('u2')]))
    expect(second.display.slice(0, first.display.length)).toEqual(first.display)
    first.display.forEach((item, index) => expect(second.display[index]).toBe(item))
  })

  test('events that are not an extension of the last ones are derived from scratch', () => {
    const first = deriveConversation(null, [user('u1'), event('a1')])
    const other = [user('v1'), call('c1')]
    expect(deriveConversation(first, other).display).toEqual(full(other))
  })
})
