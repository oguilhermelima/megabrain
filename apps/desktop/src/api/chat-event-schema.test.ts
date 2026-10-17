import { describe, expect, test } from 'bun:test'
import { transcriptEventSchema } from '@/api/schema'

describe('chat cut and background task events', () => {
  test('parses a named turn cut', () => {
    expect(transcriptEventSchema.parse({ id: 'cut', at: null, kind: 'turn-cut', text: '', reason: 'interrupted', partial: true })).toMatchObject({ kind: 'turn-cut', reason: 'interrupted', partial: true })
  })

  test('parses durable background task states', () => {
    expect(transcriptEventSchema.parse({ id: 'task', at: null, kind: 'background-task', text: 'Build', backgroundTask: { id: 'build-1', kind: 'shell', label: 'Build', state: 'running', startedAt: '2026-10-17T00:00:00Z' } })).toMatchObject({ backgroundTask: { id: 'build-1', state: 'running' } })
  })
})
