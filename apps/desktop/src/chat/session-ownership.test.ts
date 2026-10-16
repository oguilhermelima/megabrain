import { describe, expect, test } from 'bun:test'
import type { ProjectSession } from '@/api/schema'
import { ownedTerminalTarget, ownership, sessionView } from '@/chat/session-ownership'

const session: ProjectSession = {
  agent: 'claude',
  sessionId: 'claude:0f3a9c12-7d44-4b2e-9a51-3c2b1e0d9f88',
  title: 'Fix the parser',
  status: 'idle',
  startedAt: '2026-10-15T12:00:00Z',
  lastActivityAt: '2026-10-15T12:30:00Z',
  dispatchId: null,
}

const owned: ProjectSession = { ...session, owner: 'megabrain', tmuxServer: 'megabrain-app', tmuxSession: 'mb-claude-0f3a9c12' }

describe('ownership', () => {
  test('a session without an owner field, from an older CLI, is external', () => {
    expect(ownership(session)).toEqual({ owned: false })
  })

  test('owner external is external', () => {
    expect(ownership({ ...session, owner: 'external' })).toEqual({ owned: false })
  })

  test('owner megabrain with its tmux session is owned', () => {
    expect(ownership(owned)).toEqual({ owned: true, tmuxServer: 'megabrain-app', tmuxSession: 'mb-claude-0f3a9c12' })
  })

  test('owner megabrain without a tmux session cannot be attached, so it is treated as external', () => {
    expect(ownership({ ...owned, tmuxSession: null })).toEqual({ owned: false })
    expect(ownership({ ...owned, tmuxServer: undefined })).toEqual({ owned: false })
  })
})

describe('ownedTerminalTarget', () => {
  test('is server:session for the tmux engine', () => {
    expect(ownedTerminalTarget(owned)).toBe('megabrain-app:mb-claude-0f3a9c12')
  })

  test('is null for an external session', () => {
    expect(ownedTerminalTarget(session)).toBeNull()
  })
})

describe('sessionView', () => {
  test('an owned session shows what was chosen', () => {
    expect(sessionView(owned, 'chat')).toBe('chat')
    expect(sessionView(owned, 'terminal')).toBe('terminal')
  })

  test('an external session always shows the chat, whatever was chosen', () => {
    expect(sessionView(session, 'terminal')).toBe('chat')
  })

  test('a session released while on the terminal falls back to the chat', () => {
    expect(sessionView({ ...owned, owner: 'external', tmuxSession: null, tmuxServer: null }, 'terminal')).toBe('chat')
  })
})
