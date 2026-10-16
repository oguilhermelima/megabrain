import { describe, expect, test } from 'bun:test'
import { createSwitchTrace, markStep, traceRecord } from '@/native-chat/switch-trace'

describe('the switch trace record', () => {
  test('to the terminal: each step in ms since the click, rounded, in the order they happened', () => {
    const trace = createSwitchTrace({ chatId: 'chat-1', agent: 'claude', to: 'terminal' }, 1000, '2026-10-16T15:41:28.000Z')
    markStep(trace, 'modeSent', 1002.4)
    markStep(trace, 'terminalOpenCalled', 1003)
    markStep(trace, 'modeReturned', 1350.6)
    markStep(trace, 'terminalOpened', 1420)
    markStep(trace, 'firstOutput', 2400)
    markStep(trace, 'firstPaint', 2416)
    expect(traceRecord(trace, 'ok')).toEqual({
      kind: 'chat-switch',
      to: 'terminal',
      chatId: 'chat-1',
      agent: 'claude',
      at: '2026-10-16T15:41:28.000Z',
      outcome: 'ok',
      totalMs: 1416,
      steps: { click: 0, modeSent: 2, terminalOpenCalled: 3, modeReturned: 351, terminalOpened: 420, firstOutput: 1400, firstPaint: 1416 },
    })
  })

  test('the first mark of a step wins; a later one does not move it', () => {
    const trace = createSwitchTrace({ chatId: 'c', agent: 'codex', to: 'chat' }, 0, '2026-10-16T00:00:00.000Z')
    markStep(trace, 'firstState', 40)
    markStep(trace, 'firstState', 90)
    expect(traceRecord(trace, 'ok').steps.firstState).toBe(40)
  })

  test('back to chat with an error keeps the steps reached and the message', () => {
    const trace = createSwitchTrace({ chatId: 'c', agent: 'claude', to: 'chat', engine: 'tmux' }, 0, '2026-10-16T00:00:00.000Z')
    markStep(trace, 'terminalClosed', 12)
    markStep(trace, 'modeSent', 13)
    expect(traceRecord(trace, 'error', 'chat not found')).toEqual({
      kind: 'chat-switch',
      to: 'chat',
      chatId: 'c',
      agent: 'claude',
      engine: 'tmux',
      at: '2026-10-16T00:00:00.000Z',
      outcome: 'error',
      error: 'chat not found',
      totalMs: 13,
      steps: { click: 0, terminalClosed: 12, modeSent: 13 },
    })
  })

  test('a trace closed by its timeout says so', () => {
    const trace = createSwitchTrace({ chatId: 'c', agent: 'claude', to: 'terminal' }, 0, '2026-10-16T00:00:00.000Z')
    markStep(trace, 'modeSent', 1)
    expect(traceRecord(trace, 'timeout')).toMatchObject({ outcome: 'timeout', totalMs: 1 })
  })
})
