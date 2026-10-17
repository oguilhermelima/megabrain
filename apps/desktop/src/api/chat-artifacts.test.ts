import { describe, expect, test } from 'bun:test'
import { chatArtifactContentSchema, chatArtifactListSchema, chatEventLineSchema } from '@/api/schema'

// The contract of megabrain chat artifacts <chat-id> --json, chat artifact <chat-id> <artifact-id> --json,
// and the live-only artifacts event on the chat's event stream.

const listed = {
  artifacts: [
    { id: 'a-3', source: 'claude-design', title: 'Onboarding redesign', format: 'url', url: 'https://claude.ai/design/p/abc', updatedAt: '2026-10-17T12:40:00Z', revision: null, editable: false },
    { id: 'a-2', source: 'megabrain', title: 'Knowledge pipeline', format: 'html', path: '/state/knowledge/a-2/content.html', updatedAt: '2026-10-17T12:30:00Z', revision: 3, editable: false },
    { id: 'a-1', source: 'codex-plan', title: 'Plan', format: 'markdown', updatedAt: '2026-10-17T12:00:00Z', revision: 1, editable: false, extra: 'kept' },
  ],
}

describe('chat artifacts --json', () => {
  test('parses every source and format', () => {
    const parsed = chatArtifactListSchema.parse(listed)
    expect(parsed.artifacts.map((artifact) => artifact.source)).toEqual(['claude-design', 'megabrain', 'codex-plan'])
    expect(parsed.artifacts[0]?.url).toBe('https://claude.ai/design/p/abc')
    expect(parsed.artifacts[0]?.revision).toBeNull()
    expect(parsed.artifacts[1]?.path).toBe('/state/knowledge/a-2/content.html')
    expect(parsed.artifacts[2]?.path).toBeUndefined()
  })

  test('takes the other sources the contract names', () => {
    for (const source of ['claude-artifact', 'agy', 'grok']) {
      const artifact = { id: source, source, title: source, format: 'text', updatedAt: '2026-10-17T12:00:00Z', revision: 2, editable: false }
      expect(chatArtifactListSchema.safeParse({ artifacts: [artifact] }).success).toBe(true)
    }
  })

  test('an empty list parses', () => {
    expect(chatArtifactListSchema.parse({ artifacts: [] }).artifacts).toEqual([])
  })

  test('rejects an unknown format', () => {
    const artifact = { ...listed.artifacts[1], format: 'pdf' }
    expect(chatArtifactListSchema.safeParse({ artifacts: [artifact] }).success).toBe(false)
  })
})

describe('chat artifact --json', () => {
  test('parses content with its artifact', () => {
    const parsed = chatArtifactContentSchema.parse({ artifact: listed.artifacts[1], content: '<p>hi</p>', updatedAt: '2026-10-17T12:30:00Z' })
    expect(parsed.content).toBe('<p>hi</p>')
    expect(parsed.artifact.id).toBe('a-2')
    expect(parsed.reason).toBeUndefined()
  })

  test('null content carries the reason', () => {
    const parsed = chatArtifactContentSchema.parse({ artifact: listed.artifacts[0], content: null, updatedAt: '2026-10-17T12:40:00Z', reason: 'url only' })
    expect(parsed.content).toBeNull()
    expect(parsed.reason).toBe('url only')
  })
})

describe('the artifacts event', () => {
  test('a live line with cursor "" keeps its artifacts event', () => {
    const line = chatEventLineSchema.parse({ cursor: '', event: { kind: 'artifacts', at: '2026-10-17T12:41:00Z' } })
    expect(line.cursor).toBe('')
    expect(line.event?.kind).toBe('artifacts')
  })

  test('the event needs no time', () => {
    expect(chatEventLineSchema.parse({ cursor: '', event: { kind: 'artifacts' } }).event?.kind).toBe('artifacts')
  })
})
