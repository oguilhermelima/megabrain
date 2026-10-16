import { describe, expect, test } from 'bun:test'
import type { ProjectSession } from '@/api/schema'
import { isMissingLog, noLogState } from '@/chat/session-open-model'

// The error the CLI gives for a live session whose agent has not written its log yet (captured).
const missing = new Error('megabrain: session log unavailable for claude:6e69d457-6446-4efa-b65f-01d6987cc048; no dispatch terminal is associated with this session')

const session = (extra: Partial<ProjectSession> = {}): ProjectSession => ({
  agent: 'claude',
  sessionId: 'claude:6e69d457-6446-4efa-b65f-01d6987cc048',
  title: 'Claude',
  status: 'idle',
  startedAt: '2026-10-16T19:55:28.272Z',
  lastActivityAt: '2026-10-16T19:55:28.383Z',
  dispatchId: null,
  ...extra,
})

describe('isMissingLog', () => {
  test('recognises a session whose log does not exist yet', () => {
    expect(isMissingLog(missing)).toBe(true)
    expect(isMissingLog(missing.message)).toBe(true)
  })

  test('any other failure is still an error', () => {
    expect(isMissingLog(new Error('megabrain: database is locked'))).toBe(false)
    expect(isMissingLog(null)).toBe(false)
  })
})

describe('noLogState', () => {
  test("the app's own agent shows its live state and switches to its terminal", () => {
    expect(noLogState(session({ owner: 'megabrain', terminalPid: 54192 }), true)).toEqual({ activity: 'Idle', note: 'Nothing is recorded in this conversation yet.', action: 'terminal' })
    expect(noLogState(session({ owner: 'megabrain', tmuxServer: 'megabrain-app', tmuxSession: 'mb-claude-6e69d457', status: 'working' }), false)).toMatchObject({ activity: 'Working', action: 'terminal' })
  })

  test("the app's own agent with no terminal left has nothing to switch to", () => {
    expect(noLogState(session({ owner: 'megabrain', terminalPid: 54192 }), false)).toMatchObject({ action: null })
  })

  test('a session from another terminal says so and offers to open it here', () => {
    expect(noLogState(session({ owner: 'external' }), false)).toEqual({ activity: 'Idle', note: 'This session runs in another terminal.', action: 'open-here' })
    expect(noLogState(session(), false)).toMatchObject({ action: 'open-here' })
  })

  test('an ended or unownable session offers nothing', () => {
    expect(noLogState(session({ status: 'ended' }), false)).toMatchObject({ activity: 'Ended', action: null })
    expect(noLogState(session({ agent: 'grok', sessionId: 'grok:1' }), false)).toMatchObject({ action: null })
  })
})
