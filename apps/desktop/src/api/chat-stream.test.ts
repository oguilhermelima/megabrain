import { describe, expect, test } from 'bun:test'
import type { ChatEventLine } from '@/api/schema'
import { chatEventLineSchema } from '@/api/schema'
import { chatStreamReader } from '@/api/chat-stream'

const summary = { cursor: '129', event: { id: 'f848e7c2', at: '2026-10-17T02:00:23.546Z', kind: 'summary', text: 'A pessoa perguntou sobre o estado geral das merges.' } }

describe('a chat follow line', () => {
  test('an event kind this app does not know parses as a line without an event, keeping its cursor', () => {
    const parsed = chatEventLineSchema.parse(summary)
    expect(parsed.cursor).toBe('129')
    expect(parsed.event).toBeUndefined()
  })

  test('the head line keeps its chat and queue beside an unknown event', () => {
    const parsed = chatEventLineSchema.parse({ ...summary, queue: [] })
    expect(parsed.queue).toEqual([])
  })
})

describe('the follow stream reader', () => {
  const read = () => {
    const lines: ChatEventLine[] = []
    const ends: (string | null)[] = []
    const failures: unknown[] = []
    const reader = chatStreamReader(
      (line) => {
        if (line.cursor === '3') throw new Error('the view failed on this line')
        lines.push(line)
      },
      (error) => ends.push(error),
      (caught) => failures.push(caught),
    )
    return { reader, lines, ends, failures }
  }

  test('a line that does not parse or that its handler fails on never stops the lines after it', () => {
    const { reader, lines, failures } = read()
    reader(JSON.stringify({ cursor: '1', event: { id: 'e1', at: null, kind: 'assistant', text: 'one' } }))
    reader(JSON.stringify(summary))
    reader('{"cursor": 2, "broken"')
    reader(JSON.stringify({ cursor: '3', event: { id: 'e3', at: null, kind: 'assistant', text: 'three' } }))
    reader(JSON.stringify({ cursor: '4', event: { id: 'e4', at: null, kind: 'assistant', text: 'four' } }))
    expect(lines.map((line) => line.cursor)).toEqual(['1', '129', '4'])
    expect(failures).toHaveLength(2)
  })

  test('the end marker ends the follow with the error the CLI printed before it', () => {
    const { reader, lines, ends } = read()
    reader('{"cursor":"","error":"chatd is not running"}')
    reader('{"cursor":"","end":true}')
    expect(lines).toEqual([])
    expect(ends).toEqual(['chatd is not running'])
  })
})
