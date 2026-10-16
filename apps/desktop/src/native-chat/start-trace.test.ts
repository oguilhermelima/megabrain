import { describe, expect, test } from 'bun:test'
import { createStartTrace, markStartEvent, markStartStep, startRecord } from '@/native-chat/start-trace'

// The click happens at performance time 1000 and wall time 2026-10-16T15:00:00.000Z.
const wall = Date.parse('2026-10-16T15:00:00.000Z')
const at = (ms: number) => new Date(wall + ms).toISOString()
const event = (kind: string, text: string, ms: number) => ({ kind, text, at: at(ms) })

describe('the chat start trace', () => {
  test('app steps count from the click; daemon steps from the event times, on the same clock', () => {
    const trace = createStartTrace({ agent: 'claude', withMessage: true }, 1000, wall)
    markStartStep(trace, 'startSent', 1003.2)
    markStartStep(trace, 'startReturned', 1410.6)
    trace.chatId = 'chat-1'
    markStartStep(trace, 'followCalled', 1810)
    expect(markStartEvent(trace, event('state', 'starting', 300), 2000)).toBe(false)
    expect(markStartEvent(trace, event('system', 'Started claude chat', 301), 2000)).toBe(false)
    expect(markStartEvent(trace, event('user', 'hello', 302), 2001)).toBe(false)
    expect(markStartEvent(trace, event('state', 'idle', 2600), 3700)).toBe(false)
    expect(markStartEvent(trace, event('state', 'working', 2605), 3705)).toBe(false)
    expect(markStartEvent(trace, event('delta', 'Hi', 4100.4), 5200)).toBe(true)
    expect(startRecord(trace, 'ok')).toEqual({
      kind: 'chat-start',
      chatId: 'chat-1',
      agent: 'claude',
      at: '2026-10-16T15:00:00.000Z',
      withMessage: true,
      outcome: 'ok',
      totalMs: 4200,
      steps: { click: 0, startSent: 3, startReturned: 411, followCalled: 810, firstState: 1000, created: 301, agentReady: 2600, agentReadyShown: 2700, firstOutput: 4100, firstOutputShown: 4200 },
    })
  })

  test('without a message the start settles when the agent is ready', () => {
    const trace = createStartTrace({ agent: 'codex', withMessage: false }, 0, wall)
    expect(markStartEvent(trace, event('state', 'starting', 50), 60)).toBe(false)
    expect(markStartEvent(trace, event('state', 'idle', 900), 950)).toBe(true)
    expect(startRecord(trace, 'ok').steps).toEqual({ click: 0, firstState: 60, agentReady: 900, agentReadyShown: 950 })
  })

  test('the first mark of a step wins, and an unreadable event time marks nothing', () => {
    const trace = createStartTrace({ agent: 'claude', withMessage: true }, 0, wall)
    markStartStep(trace, 'startReturned', 40)
    markStartStep(trace, 'startReturned', 90)
    markStartEvent(trace, { kind: 'system', text: 'Started claude chat', at: 'not a time' }, 100)
    markStartEvent(trace, event('system', 'Started claude chat', 20), 100)
    markStartEvent(trace, event('system', 'Started claude chat', 70), 110)
    expect(startRecord(trace, 'ok').steps).toEqual({ click: 0, startReturned: 40, created: 20 })
  })

  test('a failed start is written with its error and the steps it reached', () => {
    const trace = createStartTrace({ agent: 'claude', withMessage: false }, 0, wall)
    markStartStep(trace, 'startSent', 2)
    expect(startRecord(trace, 'error', 'chatd is not running')).toEqual({
      kind: 'chat-start',
      chatId: null,
      agent: 'claude',
      at: '2026-10-16T15:00:00.000Z',
      withMessage: false,
      outcome: 'error',
      error: 'chatd is not running',
      totalMs: 2,
      steps: { click: 0, startSent: 2 },
    })
  })
})
