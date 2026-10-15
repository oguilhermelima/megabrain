import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranscriptEvent } from '@/api/schema'
import { buildConversationItems, formatText, mergeEvents, relayedPreview, relayedTarget } from '@/chat/conversation-model'
import { MarkdownText } from '@/chat/markdown'

function event(id: string, fields: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { id, at: null, kind: 'assistant', text: '', ...fields }
}

describe('buildConversationItems', () => {
  test('pairs a tool-call with the tool-result right after it', () => {
    const items = buildConversationItems([
      event('c1', { kind: 'tool-call', text: 'ls', tool: { name: 'shell', input: 'ls' } }),
      event('r1', { kind: 'tool-result', text: 'a.ts', tool: { name: 'shell', status: 'ok' } }),
    ])
    expect(items).toEqual([
      {
        type: 'tool',
        id: 'c1',
        call: event('c1', { kind: 'tool-call', text: 'ls', tool: { name: 'shell', input: 'ls' } }),
        result: event('r1', { kind: 'tool-result', text: 'a.ts', tool: { name: 'shell', status: 'ok' } }),
        status: 'ok',
      },
    ])
  })

  test('a tool-call with no result yet is running', () => {
    const items = buildConversationItems([event('c1', { kind: 'tool-call', text: 'ls', tool: { name: 'shell', input: 'ls' } })])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'tool', status: 'running', result: null })
  })

  test('a failed result carries error status', () => {
    const items = buildConversationItems([
      event('c1', { kind: 'tool-call', tool: { name: 'shell', input: 'bad' } }),
      event('r1', { kind: 'tool-result', tool: { name: 'shell', status: 'error' } }),
    ])
    expect(items[0]).toMatchObject({ status: 'error' })
  })

  test('user, assistant, thinking and system events pass through as messages', () => {
    const items = buildConversationItems([event('u1', { kind: 'user' }), event('t1', { kind: 'thinking' }), event('s1', { kind: 'system' })])
    expect(items.map((item) => item.type)).toEqual(['message', 'message', 'message'])
  })

  test('a lone tool-result with no preceding call is dropped, never shown twice', () => {
    const items = buildConversationItems([event('r1', { kind: 'tool-result' })])
    expect(items).toEqual([])
  })
})

describe('mergeEvents', () => {
  test('appends only events whose id is new, in the order given', () => {
    const merged = mergeEvents([event('a'), event('b')], [event('b'), event('c')])
    expect(merged.map((event_) => event_.id)).toEqual(['a', 'b', 'c'])
  })

  test('an empty incoming batch changes nothing', () => {
    const merged = mergeEvents([event('a')], [])
    expect(merged.map((event_) => event_.id)).toEqual(['a'])
  })

  test('merging into an empty known list just adopts the incoming order', () => {
    const merged = mergeEvents([], [event('a'), event('b')])
    expect(merged.map((event_) => event_.id)).toEqual(['a', 'b'])
  })
})

describe('formatText', () => {
  test('plain text with no fences or inline code is a single text segment', () => {
    expect(formatText('hello world')).toEqual([{ type: 'text', value: 'hello world' }])
  })

  test('a fenced block becomes its own code segment, stripped of its language line', () => {
    expect(formatText('before\n```ts\nconst x = 1\n```\nafter')).toEqual([
      { type: 'text', value: 'before\n' },
      { type: 'code', value: 'const x = 1\n' },
      { type: 'text', value: '\nafter' },
    ])
  })

  test('inline code within plain text becomes an inline-code segment', () => {
    expect(formatText('run `bun test` now')).toEqual([
      { type: 'text', value: 'run ' },
      { type: 'inline-code', value: 'bun test' },
      { type: 'text', value: ' now' },
    ])
  })
})

describe('relayedPreview', () => {
  test('takes the first line of a relayed message as its preview', () => {
    expect(relayedPreview('All gates passed.\nTypecheck: 12/12\nTests: 40/40')).toBe('All gates passed.')
  })

  test('a one-line message previews as itself', () => {
    expect(relayedPreview('Done.')).toBe('Done.')
  })

  test('an empty message previews as an empty string', () => {
    expect(relayedPreview('')).toBe('')
  })
})

describe('relayedTarget', () => {
  test('prefers dispatchId when both are present', () => {
    expect(relayedTarget({ kind: 'child', label: 'lane', dispatchId: 'd1', sessionId: 's1' })).toEqual({ dispatchId: 'd1' })
  })

  test('falls back to sessionId when dispatchId is null', () => {
    expect(relayedTarget({ kind: 'parent', label: 'lane', dispatchId: null, sessionId: 's1' })).toEqual({ sessionId: 's1' })
  })

  test('is null when neither id is present', () => {
    expect(relayedTarget({ kind: 'child', label: 'lane', dispatchId: null, sessionId: null })).toBeNull()
  })
})

describe('MarkdownText sanitize', () => {
  test('strips script, iframe, style tags and on* attribute handlers from raw HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownText, {
        text: [
          'before',
          '<script>alert(1)</script>',
          '<iframe src="https://evil.example"></iframe>',
          '<style>body{display:none}</style>',
          '<div onclick="alert(2)">click me</div>',
          'after',
        ].join('\n\n'),
      }),
    )
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('<style')
    expect(markup).not.toContain('onclick')
    expect(markup).toContain('before')
    expect(markup).toContain('click me')
    expect(markup).toContain('after')
  })

  test('renders a link as inert text carrying the url as a hover title, never an href', () => {
    const markup = renderToStaticMarkup(createElement(MarkdownText, { text: '[docs](https://example.com/docs)' }))
    expect(markup).not.toContain('href=')
    expect(markup).toContain('title="https://example.com/docs"')
    expect(markup).toContain('docs')
  })
})
