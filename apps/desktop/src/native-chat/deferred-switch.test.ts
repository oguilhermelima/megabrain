import { describe, expect, test } from 'bun:test'
import type { NativeChat } from '@/api/schema'
import { backToChat, chatChanged, requestTerminal, stopAndOpen, TERMINAL_WAIT_NOTICE } from '@/native-chat/deferred-switch'

const chat = (state: NativeChat['state']): NativeChat => ({
  id: 'c', agent: 'claude', model: null, cwd: '/w', title: 't', state, mode: 'chat',
  agentSessionId: 'sess', createdAt: '2026-10-16T09:00:00Z', lastActivityAt: null,
})

describe('switching a chat to its terminal while a turn runs', () => {
  test('an idle chat switches at once', () => {
    for (const state of ['idle', 'suspended', 'stopped', 'error'] as const) expect(requestTerminal(chat(state))).toEqual({ waiting: false, run: 'switch' })
  })

  test('a running turn shows the terminal view at once and waits, with no question asked', () => {
    for (const state of ['working', 'waiting-approval'] as const) expect(requestTerminal(chat(state))).toEqual({ waiting: true, run: 'nothing' })
    expect(TERMINAL_WAIT_NOTICE).toBe('Opens when this turn ends')
  })

  test('while waiting, the chat still working changes nothing', () => {
    expect(chatChanged(true, chat('working'))).toEqual({ waiting: true, run: 'nothing' })
    expect(chatChanged(true, chat('waiting-approval'))).toEqual({ waiting: true, run: 'nothing' })
  })

  test('the turn ending hands the conversation to the terminal by itself', () => {
    for (const state of ['idle', 'suspended', 'stopped', 'error'] as const) expect(chatChanged(true, chat(state))).toEqual({ waiting: false, run: 'switch' })
  })

  test('a chat that is not waiting never switches on its own', () => {
    expect(chatChanged(false, chat('idle'))).toEqual({ waiting: false, run: 'nothing' })
  })

  test('stop the turn and open now stops the turn, then switches', () => {
    expect(stopAndOpen(true)).toEqual({ waiting: false, run: 'stop-then-switch' })
    expect(stopAndOpen(false)).toEqual({ waiting: false, run: 'nothing' })
  })

  test('going back to the chat while waiting cancels the wait and is immediate', () => {
    expect(backToChat(true)).toEqual({ waiting: false, run: 'nothing' })
  })
})
