import { describe, expect, test } from 'bun:test'
import type { ProjectSession } from '@/api/schema'
import { hideSession, isHidden, noHiddenSessions, parseHiddenSessions, saveHiddenSessions, unhideSession } from '@/advanced/hidden-sessions'

const session = (sessionId: string, lastActivityAt: string | null): ProjectSession => ({
  agent: 'claude',
  sessionId,
  title: sessionId,
  status: 'idle',
  startedAt: '2026-10-15T10:00:00.000Z',
  lastActivityAt,
  dispatchId: null,
})

describe('hidden sessions', () => {
  test('a closed session stays out of the list while nothing new happens in it', () => {
    const quiet = session('claude:1', '2026-10-15T10:00:00.000Z')
    const hidden = hideSession(noHiddenSessions, quiet)
    expect(isHidden(hidden, quiet)).toBe(true)
    expect(isHidden(hidden, session('claude:2', '2026-10-15T10:00:00.000Z'))).toBe(false)
  })

  test('it comes back once it shows newer activity', () => {
    const hidden = hideSession(noHiddenSessions, session('claude:1', '2026-10-15T10:00:00.000Z'))
    expect(isHidden(hidden, session('claude:1', '2026-10-15T10:05:00.000Z'))).toBe(false)
  })

  test('a session with no recorded activity stays hidden until it records some', () => {
    const hidden = hideSession(noHiddenSessions, session('claude:1', null))
    expect(isHidden(hidden, session('claude:1', null))).toBe(true)
    expect(isHidden(hidden, session('claude:1', '2026-10-15T10:05:00.000Z'))).toBe(false)
  })

  test('unhiding brings it back by hand', () => {
    const quiet = session('claude:1', '2026-10-15T10:00:00.000Z')
    expect(isHidden(unhideSession(hideSession(noHiddenSessions, quiet), quiet.sessionId), quiet)).toBe(false)
  })

  test('the saved form reads back the same', () => {
    const hidden = hideSession(hideSession(noHiddenSessions, session('claude:1', '2026-10-15T10:00:00.000Z')), session('codex:2', null))
    expect(parseHiddenSessions(JSON.parse(saveHiddenSessions(hidden)))).toEqual(hidden)
  })

  test('anything else reads as nothing hidden, and bad entries are dropped', () => {
    for (const raw of [null, 'x', [], { version: 2, sessions: {} }, { version: 1, sessions: [] }]) expect(parseHiddenSessions(raw)).toEqual(noHiddenSessions)
    expect(parseHiddenSessions({ version: 1, sessions: { 'claude:1': 4, 'claude:2': null } })).toEqual({ version: 1, sessions: { 'claude:2': null } })
  })
})
