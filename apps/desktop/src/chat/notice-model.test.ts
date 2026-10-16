import { describe, expect, test } from 'bun:test'
import type { Dispatch, TranscriptEvent } from '@/api/schema'
import { transcriptEventSchema } from '@/api/schema'
import { collapseNotices, liveNotice, noticeTone, type Notice } from '@/chat/notice-model'
import type { DisplayItem } from '@/chat/tool-groups'

function notice(fields: Partial<Notice> = {}): Notice {
  return { kind: 'stuck', agent: 'claude', label: 'feat/seek-bar', dispatchId: '7a1c9e03', summary: 'claude · feat/seek-bar is stuck', ...fields }
}
function message(id: string, fields: Partial<TranscriptEvent> = {}): DisplayItem {
  return { type: 'message', event: { id, at: null, kind: 'system', text: `Message from megabrain: ${id}`, ...fields } }
}
const noticeItem = (id: string, fields: Partial<Notice> = {}) => message(id, { notice: notice(fields) })
const assistant = (id: string) => message(id, { kind: 'assistant', text: id })

function dispatch(fields: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: 'dispatch-20261014205812000-41022-7a1c9e03',
    state: 'running',
    owner: 'mine',
    createdAt: '2026-10-14T20:58:12.000Z',
    updatedAt: '2026-10-14T21:00:00.000Z',
    supervision: { lastCheck: null, finding: null },
    ...fields,
  }
}

describe('noticeTone', () => {
  test('each kind has its tone', () => {
    expect(noticeTone('finished')).toBe('ok')
    expect(noticeTone('ask')).toBe('accent')
    expect(noticeTone('stuck')).toBe('warn')
    expect(noticeTone('limit')).toBe('warn')
    expect(noticeTone('failed')).toBe('bad')
    expect(noticeTone('other')).toBe('neutral')
  })
})

describe('the notice field in the schema', () => {
  const base = { id: 'n1', at: null, kind: 'system', text: 'Message from megabrain: ✅ codex · x finished' }
  test('an event without it still parses', () => {
    expect(transcriptEventSchema.parse(base).notice).toBeUndefined()
  })
  test('an event with it keeps every field', () => {
    expect(transcriptEventSchema.parse({ ...base, notice: notice({ kind: 'finished' }) }).notice).toEqual(notice({ kind: 'finished' }))
  })
  test('a kind or agent this app does not know reads as other and no agent, without failing the transcript', () => {
    const parsed = transcriptEventSchema.parse({ ...base, notice: { ...notice(), kind: 'paused', agent: 'gemini' } }).notice
    expect(parsed?.kind).toBe('other')
    expect(parsed?.agent).toBeNull()
  })
})

describe('collapseNotices', () => {
  test('rows without a notice pass through untouched', () => {
    const rows = [assistant('a1'), message('s1'), assistant('a2')]
    const collapsed = collapseNotices(rows)
    expect(collapsed).toHaveLength(3)
    collapsed.forEach((row, index) => expect(row).toBe(rows[index] as DisplayItem))
  })

  test('a single notice becomes one card with a count of one', () => {
    const [card] = collapseNotices([noticeItem('n1')])
    expect(card?.type).toBe('notice')
    if (card?.type !== 'notice') return
    expect(card.events.map((event) => event.id)).toEqual(['n1'])
    expect(card.notice.kind).toBe('stuck')
  })

  test('consecutive notices for the same dispatch collapse into one card that shows the latest', () => {
    const collapsed = collapseNotices([noticeItem('n1'), noticeItem('n2'), noticeItem('n3', { kind: 'finished', summary: 'codex · feat/seek-bar finished' })])
    expect(collapsed).toHaveLength(1)
    const card = collapsed[0]
    if (card?.type !== 'notice') throw new Error('expected a notice card')
    expect(card.events.map((event) => event.id)).toEqual(['n1', 'n2', 'n3'])
    expect(card.notice.kind).toBe('finished')
    expect(card.notice.summary).toBe('codex · feat/seek-bar finished')
  })

  test('the full id and its 8-character suffix name the same dispatch', () => {
    const collapsed = collapseNotices([noticeItem('n1'), noticeItem('n2', { dispatchId: 'dispatch-20261014205812000-41022-7a1c9e03' })])
    expect(collapsed).toHaveLength(1)
  })

  test('a different dispatch starts a new card', () => {
    const collapsed = collapseNotices([noticeItem('n1'), noticeItem('n2', { dispatchId: '3c4d5e6f' }), noticeItem('n3')])
    expect(collapsed.map((row) => row.type)).toEqual(['notice', 'notice', 'notice'])
  })

  test('any other row between two notices keeps them apart', () => {
    const collapsed = collapseNotices([noticeItem('n1'), assistant('a1'), noticeItem('n2')])
    expect(collapsed.map((row) => row.type)).toEqual(['notice', 'message', 'notice'])
  })

  test('notices that name no dispatch never collapse', () => {
    const collapsed = collapseNotices([noticeItem('n1', { dispatchId: null }), noticeItem('n2', { dispatchId: null })])
    expect(collapsed).toHaveLength(2)
  })

  test('a card keeps its identity when the rows it came from did not change', () => {
    const rows = [noticeItem('n1'), noticeItem('n2'), assistant('a1')]
    const first = collapseNotices(rows)
    const again = collapseNotices([...rows, assistant('a2')], first)
    expect(again[0]).toBe(first[0] as (typeof again)[number])
  })

  test('a card that gained a notice is a new card', () => {
    const rows = [noticeItem('n1')]
    const first = collapseNotices(rows)
    const again = collapseNotices([...rows, noticeItem('n2')], first)
    expect(again[0]).not.toBe(first[0] as (typeof again)[number])
  })
})

describe('liveNotice', () => {
  test('with no dispatch known the notice reads as it arrived and has no live line', () => {
    expect(liveNotice(notice(), [])).toEqual({ kind: 'stuck', tone: 'warn', state: null })
  })

  test('a dispatch is found by its 8-character suffix', () => {
    expect(liveNotice(notice(), [dispatch({ dispatchId: 'dispatch-1-3c4d5e6f' }), dispatch()]).state).toBe('working')
  })

  test('a stuck notice reads finished once its dispatch finished', () => {
    expect(liveNotice(notice(), [dispatch({ state: 'done' })])).toEqual({ kind: 'finished', tone: 'ok', state: 'finished' })
  })

  test('a question reads failed once its dispatch failed', () => {
    expect(liveNotice(notice({ kind: 'ask' }), [dispatch({ state: 'failed' })])).toEqual({ kind: 'failed', tone: 'bad', state: 'failed' })
  })

  test('a finished notice stays finished after its dispatch is closed', () => {
    expect(liveNotice(notice({ kind: 'finished' }), [dispatch({ state: 'closed' })])).toEqual({ kind: 'finished', tone: 'ok', state: 'closed' })
  })

  test('a running dispatch with a supervisor finding says it needs you, with the cause', () => {
    const live = liveNotice(notice(), [dispatch({ supervision: { lastCheck: null, finding: { cause: 'usage limit' } } })])
    expect(live).toEqual({ kind: 'stuck', tone: 'warn', state: 'needs you · usage limit' })
  })

  test('a stuck notice whose dispatch is working again keeps its kind and says working', () => {
    expect(liveNotice(notice(), [dispatch()])).toEqual({ kind: 'stuck', tone: 'warn', state: 'working' })
  })
})
