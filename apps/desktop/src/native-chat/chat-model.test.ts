import { describe, expect, test } from 'bun:test'
import type { ChatApproval, ChatEventLine, NativeChat, TranscriptEvent } from '@/api/schema'
import { applyLine, chatsByWorktree, compareCursors, composerContext, followState, markAnswered, modeToggle, pendingApproval, rowStatus, shouldInterrupt, withModel } from '@/native-chat/chat-model'

const chat: NativeChat = {
  id: 'chat-1',
  agent: 'claude',
  model: null,
  cwd: '/work/repo',
  title: 'Tidy',
  state: 'working',
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-15T12:00:00Z',
  lastActivityAt: '2026-10-15T12:01:00Z',
}

const event = (id: string, kind: TranscriptEvent['kind'] = 'assistant'): TranscriptEvent => ({ id, at: null, kind, text: id })
const line = (cursor: string, extra: Omit<ChatEventLine, 'cursor'> = {}): ChatEventLine => ({ cursor, ...extra })
const approval = (id: string): ChatApproval => ({ id, tool: 'Bash', input: 'pnpm test', reason: 'Runs the tests', decisions: ['allow', 'allow-session', 'deny'] })

describe('compareCursors', () => {
  test('numeric cursors compare as numbers, not as text', () => {
    expect(compareCursors('9', '10')).toBeLessThan(0)
    expect(compareCursors('10', '9')).toBeGreaterThan(0)
    expect(compareCursors('12', '12')).toBe(0)
  })

  test('other cursors compare as text', () => {
    expect(compareCursors('a-1', 'a-2')).toBeLessThan(0)
  })
})

describe('applyLine', () => {
  test('appends events in cursor order and advances the cursor', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1', 'user') }))
    state = applyLine(state, line('2', { event: event('e2') }))
    expect(state.events.map((item) => item.id)).toEqual(['e1', 'e2'])
    expect(state.cursor).toBe('2')
  })

  test('a line at or before the cursor is a replay and leaves the state unchanged', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1') }))
    state = applyLine(state, line('2', { event: event('e2') }))
    const replayed = applyLine(state, line('2', { event: event('e2') }))
    expect(replayed).toBe(state)
    expect(applyLine(state, line('1', { event: event('e1-again') }))).toBe(state)
  })

  test('an event id already shown is not added twice even under a newer cursor', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1') }))
    state = applyLine(state, line('2', { event: event('e1') }))
    expect(state.events.map((item) => item.id)).toEqual(['e1'])
    expect(state.cursor).toBe('2')
  })

  test('a line carrying the chat record replaces it', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { chat: { ...chat, state: 'idle', title: 'Renamed' } }))
    expect(state.chat?.state).toBe('idle')
    expect(state.chat?.title).toBe('Renamed')
    expect(state.events).toEqual([])
  })

  test('starts from no chat and takes the first record that arrives', () => {
    const state = applyLine(followState(null), line('1', { chat }))
    expect(state.chat).toEqual(chat)
  })
})

describe('approvals', () => {
  const waiting = { ...chat, state: 'waiting-approval' as const }

  test('an approval line is pending while the chat waits for it', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1', 'approval'), approval: approval('ap-1'), chat: waiting }))
    expect(pendingApproval(state)?.id).toBe('ap-1')
    expect(state.approvals['e1']?.id).toBe('ap-1')
  })

  test('answering it clears the pending approval', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1', 'approval'), approval: approval('ap-1'), chat: waiting }))
    state = markAnswered(state, 'ap-1')
    expect(pendingApproval(state)).toBeNull()
    expect(state.answered).toContain('ap-1')
  })

  test('the chat leaving waiting-approval clears it even when answered elsewhere', () => {
    let state = followState(chat)
    state = applyLine(state, line('1', { event: event('e1', 'approval'), approval: approval('ap-1'), chat: waiting }))
    state = applyLine(state, line('2', { chat: { ...chat, state: 'working' } }))
    expect(pendingApproval(state)).toBeNull()
  })

  test('the newest unanswered approval is the pending one', () => {
    let state = followState(waiting)
    state = applyLine(state, line('1', { event: event('e1', 'approval'), approval: approval('ap-1') }))
    state = applyLine(state, line('2', { event: event('e2', 'approval'), approval: approval('ap-2') }))
    expect(pendingApproval(state)?.id).toBe('ap-2')
    state = markAnswered(state, 'ap-2')
    expect(pendingApproval(state)?.id).toBe('ap-1')
  })
})

describe('modeToggle', () => {
  test('chat to terminal only while idle', () => {
    expect(modeToggle({ ...chat, state: 'idle' })).toEqual({ target: 'terminal', enabled: true, reason: null })
    for (const state of ['working', 'waiting-approval', 'starting', 'stopped', 'error'] as const) {
      const toggle = modeToggle({ ...chat, state })
      expect(toggle.target).toBe('terminal')
      expect(toggle.enabled).toBe(false)
      expect(toggle.reason).not.toBeNull()
    }
  })

  test('terminal back to chat is always offered', () => {
    expect(modeToggle({ ...chat, mode: 'terminal', state: 'working' })).toEqual({ target: 'chat', enabled: true, reason: null })
  })
})

describe('shouldInterrupt', () => {
  test('Escape in an empty composer while the agent works', () => {
    expect(shouldInterrupt('Escape', '', 'working')).toBe(true)
    expect(shouldInterrupt('Escape', '  \n', 'working')).toBe(true)
  })

  test('not with text, another key, or an agent that is not working', () => {
    expect(shouldInterrupt('Escape', 'draft', 'working')).toBe(false)
    expect(shouldInterrupt('Enter', '', 'working')).toBe(false)
    expect(shouldInterrupt('Escape', '', 'idle')).toBe(false)
  })
})

describe('chatsByWorktree', () => {
  test('files each chat under the deepest worktree that holds its folder, newest first', () => {
    const older = { ...chat, id: 'a', cwd: '/work/repo', lastActivityAt: '2026-10-15T10:00:00Z' }
    const newer = { ...chat, id: 'b', cwd: '/work/repo', lastActivityAt: '2026-10-15T11:00:00Z' }
    const nested = { ...chat, id: 'c', cwd: '/work/repo-feature/apps/web' }
    const elsewhere = { ...chat, id: 'd', cwd: '/other' }
    const grouped = chatsByWorktree([older, nested, newer, elsewhere], ['/work/repo', '/work/repo-feature'])
    expect(grouped['/work/repo']?.map((item) => item.id)).toEqual(['b', 'a'])
    expect(grouped['/work/repo-feature']?.map((item) => item.id)).toEqual(['c'])
    expect(Object.values(grouped).flat().some((item) => item.id === 'd')).toBe(false)
  })
})

describe('rowStatus', () => {
  test('maps chat states onto the sidebar dots', () => {
    expect(rowStatus('working')).toBe('working')
    expect(rowStatus('starting')).toBe('working')
    expect(rowStatus('waiting-approval')).toBe('waiting')
    expect(rowStatus('idle')).toBe('idle')
    expect(rowStatus('stopped')).toBe('ended')
    expect(rowStatus('error')).toBe('ended')
  })
})

describe('composerContext', () => {
  test('passes the tokens and window the chat reports', () => {
    expect(composerContext({ ...chat, contextTokens: 12000, contextWindow: 200000 })).toEqual({ tokens: 12000, window: 200000 })
  })

  test('keeps a known token count without a window', () => {
    expect(composerContext({ ...chat, contextTokens: 500, contextWindow: null })).toEqual({ tokens: 500, window: null })
  })

  test('is undefined when the chat reports neither', () => {
    expect(composerContext(chat)).toBeUndefined()
    expect(composerContext({ ...chat, contextTokens: null, contextWindow: null })).toBeUndefined()
  })
})

describe('withModel', () => {
  test('sets the model on the followed record', () => {
    const state = { ...followState({ ...chat, model: 'opus' }), cursor: '4' }
    const next = withModel(state, chat, 'sonnet')
    expect(next.chat?.model).toBe('sonnet')
    expect(next.cursor).toBe('4')
  })

  test('starts from the listed record before the first line arrives', () => {
    const next = withModel(followState(null), { ...chat, title: 'Listed' }, 'sonnet')
    expect(next.chat).toEqual({ ...chat, title: 'Listed', model: 'sonnet' })
  })
})
