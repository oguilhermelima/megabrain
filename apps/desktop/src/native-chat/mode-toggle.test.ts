import { describe, expect, test } from 'bun:test'
import type { NativeChat } from '@/api/schema'
import { modeToggle } from '@/native-chat/chat-model'

const chat: NativeChat = {
  id: 'c', agent: 'claude', model: null, cwd: '/w', title: 't', state: 'idle', mode: 'chat',
  agentSessionId: 'sess', createdAt: '2026-10-16T09:00:00Z', lastActivityAt: null,
}

describe('terminal toggle enablement', () => {
  test('enabled in every state, never silently disabled', () => {
    for (const state of ['idle', 'suspended', 'stopped', 'error', 'working', 'waiting-approval', 'starting'] as const) {
      expect(modeToggle({ ...chat, state })).toMatchObject({ target: 'terminal', enabled: true })
    }
  })

  test('enabled with no session id yet', () => {
    expect(modeToggle({ ...chat, agentSessionId: null }).enabled).toBe(true)
  })
})
