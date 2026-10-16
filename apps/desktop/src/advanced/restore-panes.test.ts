import { describe, expect, test } from 'bun:test'
import type { NativeChat } from '@/api/schema'
import { chatPaneStays, readyToPrune } from '@/advanced/restore-panes'

const chat = (id: string, extra: Partial<NativeChat> = {}): NativeChat => ({
  id, agent: 'claude', model: null, cwd: '/work/repo', title: 'a chat', state: 'suspended', mode: 'chat',
  agentSessionId: 's', createdAt: '2026-10-15T10:00:00.000Z', lastActivityAt: '2026-10-15T10:00:00.000Z', ...extra,
})

describe('restoring the panes of the last run', () => {
  test('nothing is pruned before the chat list has loaded, so a slow or failed chat list keeps every chat pane', () => {
    expect(readyToPrune({ status: true, projects: true, terminals: true, chats: false })).toBe(false)
    expect(readyToPrune({ status: true, projects: true, terminals: true, chats: true })).toBe(true)
    expect(readyToPrune({ status: false, projects: true, terminals: true, chats: true })).toBe(false)
  })

  test('a chat that was open in a pane comes back in it whatever its state or mode, without being closed first', () => {
    for (const listed of [chat('c1'), chat('c1', { state: 'idle' }), chat('c1', { state: 'error' }), chat('c1', { mode: 'terminal' })])
      expect(chatPaneStays([listed], 'c1')).toBe(true)
  })

  test('a chat the list no longer has leaves its pane', () => {
    expect(chatPaneStays([chat('c2')], 'c1')).toBe(false)
  })
})
