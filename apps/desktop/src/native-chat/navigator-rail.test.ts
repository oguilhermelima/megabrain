import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { activeTurn, chatTurns, railLayout, railShown, stepTurn, turnPreview } from '@/native-chat/navigator-rail'

const event = (id: string, kind: TranscriptEvent['kind'], text: string, at: string | null = null): TranscriptEvent => ({ id, at, kind, text })
const message = (id: string, kind: TranscriptEvent['kind'], text: string, at: string | null = null): NoticeDisplayItem => ({ type: 'message', event: event(id, kind, text, at) })
const tool = (id: string): NoticeDisplayItem => ({ type: 'tool-group', id, items: [{ type: 'tool', id: `${id}-call`, call: event(`${id}-call`, 'tool-call', 'Bash'), result: null, status: 'running' }] })

describe('chatTurns', () => {
  test('one turn per message of the person, at its row, with the answer rows left out', () => {
    const rows = [
      message('u1', 'user', 'Tidy the steps', '2026-10-17T10:00:00.000Z'),
      message('a1', 'assistant', 'Looking.'),
      tool('t1'),
      message('u2', 'user', 'Run the tests', '2026-10-17T10:05:00.000Z'),
      message('a2', 'assistant', 'Done.'),
      message('s1', 'system', 'Session resumed'),
      message('u3', 'user', 'Thanks'),
    ]
    expect(chatTurns(rows)).toEqual([
      { key: 'u1', row: 0, preview: 'Tidy the steps', at: '2026-10-17T10:00:00.000Z' },
      { key: 'u2', row: 3, preview: 'Run the tests', at: '2026-10-17T10:05:00.000Z' },
      { key: 'u3', row: 6, preview: 'Thanks', at: null },
    ])
  })

  test('no message of the person means no turns', () => {
    expect(chatTurns([message('a1', 'assistant', 'Hello'), tool('t1')])).toEqual([])
  })
})

describe('turnPreview', () => {
  test('the first line with text, trimmed', () => {
    expect(turnPreview('\n\n   Fix the build  \nthen run the tests')).toBe('Fix the build')
  })

  test('a long line is cut to 80 characters with an ellipsis', () => {
    const preview = turnPreview('x'.repeat(200))
    expect(preview.length).toBe(80)
    expect(preview.endsWith('…')).toBe(true)
  })

  test('a message with no text reads as an empty preview', () => {
    expect(turnPreview('  \n ')).toBe('')
  })
})

describe('activeTurn', () => {
  // Turns starting at 0, 500, 1000 and 1500 px in a 2000 px transcript, read through a 600 px viewport.
  const starts = [0, 500, 1000, 1500]
  const view = (offset: number) => ({ offset, height: 600, total: 2000 })

  test('the last turn that starts above the reading line, a third of the way down the view', () => {
    expect(activeTurn(starts, view(0))).toBe(0)
    expect(activeTurn(starts, view(299))).toBe(0)
    expect(activeTurn(starts, view(300))).toBe(1)
    expect(activeTurn(starts, view(850))).toBe(2)
  })

  test('scrolled to the bottom, the last turn is the one in view', () => {
    expect(activeTurn(starts, view(1400))).toBe(3)
  })

  test('above the first turn, the first one', () => {
    expect(activeTurn([400, 900], { offset: 0, height: 600, total: 2000 })).toBe(0)
  })

  test('no turns gives no active turn', () => {
    expect(activeTurn([], view(0))).toBe(-1)
  })
})

describe('railLayout', () => {
  test('room to spare keeps the 8 px gap and every tick', () => {
    expect(railLayout(5, 2, 600)).toEqual({ gap: 8, ticks: [0, 1, 2, 3, 4] })
  })

  test('too many for 8 px compresses the gap, never below 3 px', () => {
    // 50 ticks of 3 px in 300 px leave 150 px for 49 gaps: 3 px each.
    expect(railLayout(50, 0, 300)).toEqual({ gap: 3, ticks: Array.from({ length: 50 }, (_, index) => index) })
    // 30 ticks in 300 px leave 210 px for 29 gaps: 7 px each.
    expect(railLayout(30, 0, 300).gap).toBe(7)
  })

  test('beyond 3 px it samples: every Nth tick, keeping the first, the last and the active one, within the height', () => {
    const height = 300
    const layout = railLayout(1000, 537, height)
    expect(layout.gap).toBeGreaterThanOrEqual(3)
    expect(layout.ticks[0]).toBe(0)
    expect(layout.ticks.at(-1)).toBe(999)
    expect(layout.ticks).toContain(537)
    expect(layout.ticks).toEqual([...layout.ticks].sort((a, b) => a - b))
    expect(new Set(layout.ticks).size).toBe(layout.ticks.length)
    expect(layout.ticks.length * 3 + (layout.ticks.length - 1) * layout.gap).toBeLessThanOrEqual(height)
    // Sampling is even: apart from the kept ones, the ticks are one stride apart.
    const stride = (layout.ticks[1] ?? 0) - (layout.ticks[0] ?? 0)
    expect(stride).toBeGreaterThan(1)
    const sampled = layout.ticks.filter((tick) => tick !== 537 && tick !== 999)
    sampled.forEach((tick) => expect(tick % stride).toBe(0))
  })

  test('the height never scrolls: 100 turns in a short rail still fit', () => {
    const layout = railLayout(100, 99, 200)
    expect(layout.ticks.length * 3 + (layout.ticks.length - 1) * layout.gap).toBeLessThanOrEqual(200)
    expect(layout.ticks).toContain(99)
    expect(layout.ticks).toContain(0)
  })

  test('no turns, no ticks', () => {
    expect(railLayout(0, -1, 600)).toEqual({ gap: 8, ticks: [] })
  })
})

describe('railShown', () => {
  test('hidden under 3 turns', () => {
    expect(railShown(2, 1000)).toBe(false)
    expect(railShown(3, 1000)).toBe(true)
  })

  test('hidden when the chat is narrower than 700 px', () => {
    expect(railShown(10, 699)).toBe(false)
    expect(railShown(10, 700)).toBe(true)
  })
})

describe('stepTurn', () => {
  test('moves one turn up or down and stops at the ends', () => {
    expect(stepTurn(2, 1, 5)).toBe(3)
    expect(stepTurn(2, -1, 5)).toBe(1)
    expect(stepTurn(4, 1, 5)).toBe(4)
    expect(stepTurn(0, -1, 5)).toBe(0)
  })

  test('with no active turn, down goes to the first and up to the last', () => {
    expect(stepTurn(-1, 1, 5)).toBe(0)
    expect(stepTurn(-1, -1, 5)).toBe(4)
  })
})
