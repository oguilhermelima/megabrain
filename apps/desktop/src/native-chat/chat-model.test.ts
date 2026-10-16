import { describe, expect, test } from 'bun:test'
import type { ChatApproval, ChatEventLine, NativeChat, TranscriptEvent } from '@/api/schema'
import {
  applyLine,
  chatsByWorktree,
  compareCursors,
  composerContext,
  dropOutgoing,
  followState,
  formatElapsed,
  liveTail,
  markAnswered,
  modeToggle,
  pendingApproval,
  queueOutgoing,
  rowStatus,
  shouldInterrupt,
  withModel,
  workingStatus,
  type FollowState,
} from '@/native-chat/chat-model'

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

const delta = (cursor: string, messageId: string, text: string, stream: 'assistant' | 'thinking' = 'assistant'): ChatEventLine => ({
  cursor,
  event: { kind: 'delta', stream, messageId, text },
})
const stateLine = (cursor: string, value: NativeChat['state'], turnStartedAt: string | null = null): ChatEventLine => ({
  cursor,
  event: { id: `s${cursor}`, at: null, kind: 'state', text: value, ...(turnStartedAt === null ? {} : { turnStartedAt }) },
})
const final = (cursor: string, id: string, messageId: string, text: string, kind: 'assistant' | 'thinking' = 'assistant'): ChatEventLine => ({
  cursor,
  event: { id, at: null, kind, text, messageId },
})
const tailTexts = (state: FollowState) => liveTail(state).map((item) => `${item.event.kind}:${item.event.text}`)

describe('streamed chunks', () => {
  test('chunks of one message fold into a single growing draft', () => {
    let state = applyLine(followState(chat), line('1', { event: event('e1', 'user') }))
    state = applyLine(state, delta('1', 'm1', 'Hel'))
    state = applyLine(state, delta('1', 'm1', 'lo, '))
    state = applyLine(state, delta('1', 'm1', 'world'))
    expect(tailTexts(state)).toEqual(['assistant:Hello, world'])
    expect(liveTail(state)[0]?.streaming).toBe(true)
  })

  test('chunks never become history and never move the cursor', () => {
    let state = applyLine(followState(chat), line('3', { event: event('e1', 'user') }))
    state = applyLine(state, delta('3', 'm1', 'partial'))
    state = applyLine(state, delta('4', 'm1', ' more'))
    expect(state.events.map((item) => item.id)).toEqual(['e1'])
    expect(state.cursor).toBe('3')
  })

  test('thinking and assistant chunks with different ids stay apart, in arrival order', () => {
    let state = followState(chat)
    state = applyLine(state, delta('1', 't1', 'Reading the', 'thinking'))
    state = applyLine(state, delta('1', 'm1', 'Done'))
    state = applyLine(state, delta('1', 't1', ' steps', 'thinking'))
    expect(tailTexts(state)).toEqual(['thinking:Reading the steps', 'assistant:Done'])
  })

  test('the final event with the same messageId replaces its chunks', () => {
    let state = followState(chat)
    state = applyLine(state, delta('0', 'm1', 'Hel'))
    state = applyLine(state, delta('0', 'm1', 'lo'))
    state = applyLine(state, final('1', 'e9', 'm1', 'Hello.'))
    expect(liveTail(state)).toEqual([])
    expect(state.events.map((item) => item.text)).toEqual(['Hello.'])
    expect(state.cursor).toBe('1')
  })

  test('a final event replaces only its own message', () => {
    let state = followState(chat)
    state = applyLine(state, delta('0', 't1', 'hmm', 'thinking'))
    state = applyLine(state, delta('0', 'm1', 'Hi'))
    state = applyLine(state, final('1', 'e1', 't1', 'hmm, ok', 'thinking'))
    expect(tailTexts(state)).toEqual(['assistant:Hi'])
  })

  test('a chunk arriving after its final event does not bring the draft back', () => {
    let state = followState(chat)
    state = applyLine(state, delta('0', 'm1', 'Hi'))
    state = applyLine(state, final('1', 'e1', 'm1', 'Hi there'))
    state = applyLine(state, delta('1', 'm1', ' there'))
    expect(liveTail(state)).toEqual([])
  })

  test('drafts are dropped once the turn ends without their final event', () => {
    let state = applyLine(followState(chat), stateLine('1', 'working', '2026-10-15T12:00:00Z'))
    state = applyLine(state, delta('1', 'm1', 'cut off'))
    state = applyLine(state, stateLine('2', 'idle'))
    expect(liveTail(state)).toEqual([])
  })
})

describe('state events', () => {
  test('set the chat state and the turn start, and stay out of the transcript', () => {
    let state = applyLine(followState(chat), stateLine('1', 'working', '2026-10-15T12:00:00Z'))
    expect(state.chat?.state).toBe('working')
    expect(state.turnStartedAt).toBe('2026-10-15T12:00:00Z')
    expect(state.events).toEqual([])
    expect(state.cursor).toBe('1')
    state = applyLine(state, stateLine('2', 'idle'))
    expect(state.chat?.state).toBe('idle')
    expect(state.turnStartedAt).toBeNull()
  })

  test('the state sent at the start of a follow applies even at the resumed cursor', () => {
    let state = applyLine(followState(chat), line('5', { event: event('e5') }))
    state = applyLine(state, { cursor: '5', event: { id: 'start-state', at: null, kind: 'state', text: 'waiting-approval', turnStartedAt: '2026-10-15T12:00:00Z' } })
    expect(state.chat?.state).toBe('waiting-approval')
    expect(state.turnStartedAt).toBe('2026-10-15T12:00:00Z')
  })

  test('a replayed older state does not overwrite the newer one', () => {
    let state = applyLine(followState(chat), stateLine('4', 'idle'))
    state = applyLine(state, stateLine('2', 'working', '2026-10-15T11:00:00Z'))
    expect(state.chat?.state).toBe('idle')
  })

  test('a state the app does not know leaves the record alone', () => {
    const state = applyLine(followState(chat), { cursor: '1', event: { id: 's1', at: null, kind: 'state', text: 'compacting' } })
    expect(state.chat?.state).toBe('working')
  })
})

describe('optimistic messages', () => {
  const sent = { id: 'out-1', text: 'teste', sentAt: '2026-10-15T12:00:00Z' }

  test('a sent message shows at once after the history', () => {
    let state = applyLine(followState({ ...chat, state: 'idle' }), line('1', { event: event('e1') }))
    state = queueOutgoing(state, sent)
    expect(tailTexts(state)).toEqual(['user:teste'])
    expect(liveTail(state)[0]?.pending).toBe(true)
  })

  test('the user event that echoes it confirms it and takes its place', () => {
    let state = queueOutgoing(followState({ ...chat, state: 'idle' }), sent)
    state = applyLine(state, line('1', { event: { id: 'u1', at: null, kind: 'user', text: 'teste' } }))
    expect(liveTail(state)).toEqual([])
    expect(state.events.map((item) => item.id)).toEqual(['u1'])
  })

  test('the echo confirms the message with the same text, not just the oldest', () => {
    let state = followState({ ...chat, state: 'idle' })
    state = queueOutgoing(state, { id: 'out-1', text: 'first', sentAt: '2026-10-15T12:00:00Z' })
    state = queueOutgoing(state, { id: 'out-2', text: 'second', sentAt: '2026-10-15T12:00:01Z' })
    state = applyLine(state, line('1', { event: { id: 'u2', at: null, kind: 'user', text: '  second\n' } }))
    expect(tailTexts(state)).toEqual(['user:first'])
  })

  test('an echo with no matching text confirms the oldest message', () => {
    let state = followState({ ...chat, state: 'idle' })
    state = queueOutgoing(state, { id: 'out-1', text: 'look at this', sentAt: '2026-10-15T12:00:00Z' })
    state = queueOutgoing(state, { id: 'out-2', text: 'and this', sentAt: '2026-10-15T12:00:01Z' })
    state = applyLine(state, line('1', { event: { id: 'u1', at: null, kind: 'user', text: 'look at this [Image #1]' } }))
    expect(tailTexts(state)).toEqual(['user:and this'])
  })

  test('a send that failed takes its message back', () => {
    let state = queueOutgoing(followState(chat), sent)
    state = dropOutgoing(state, 'out-1')
    expect(liveTail(state)).toEqual([])
  })

  test('a message sent during a streaming reply sits after it', () => {
    let state = applyLine(followState(chat), delta('0', 'm1', 'Still writing'))
    state = queueOutgoing(state, sent)
    expect(tailTexts(state)).toEqual(['assistant:Still writing', 'user:teste'])
  })
})

describe('workingStatus', () => {
  const started = '2026-10-15T12:00:00Z'
  const working = (lines: ChatEventLine[]) => lines.reduce(applyLine, applyLine(followState({ ...chat, state: 'idle' }), stateLine('1', 'working', started)))

  test('nothing while idle, stopped or errored', () => {
    for (const value of ['idle', 'stopped', 'error'] as const) expect(workingStatus(followState({ ...chat, state: value }))).toBeNull()
  })

  test('Thinking with the turn start while the agent works and nothing streams', () => {
    expect(workingStatus(working([]))).toEqual({ label: 'Thinking', since: started })
  })

  test('Thinking while thinking streams, Writing while the reply streams', () => {
    expect(workingStatus(working([delta('1', 't1', 'hmm', 'thinking')]))?.label).toBe('Thinking')
    expect(workingStatus(working([delta('1', 't1', 'hmm', 'thinking'), delta('1', 'm1', 'Here')]))?.label).toBe('Writing')
  })

  test('Running the tool whose call has no result yet', () => {
    const call: TranscriptEvent = { id: 'c1', at: null, kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: 'ls' } }
    expect(workingStatus(working([line('2', { event: call })]))?.label).toBe('Running Bash')
    const result: TranscriptEvent = { id: 'r1', at: null, kind: 'tool-result', text: 'ok', tool: { name: 'Bash', status: 'ok' } }
    expect(workingStatus(working([line('2', { event: call }), line('3', { event: result })]))?.label).toBe('Thinking')
  })

  test('Waiting for approval while an approval waits', () => {
    const state = applyLine(working([]), stateLine('2', 'waiting-approval', started))
    expect(workingStatus(state)).toEqual({ label: 'Waiting for approval', since: started })
  })

  test('Starting the agent, timed from the turn start or else from the chat creation', () => {
    expect(workingStatus(followState({ ...chat, state: 'starting' }))).toEqual({ label: 'Starting claude…', since: chat.createdAt })
    const state = applyLine(followState({ ...chat, state: 'idle' }), stateLine('1', 'starting', started))
    expect(workingStatus(state)).toEqual({ label: 'Starting claude…', since: started })
  })

  test('a message just sent reads as Thinking before the agent reports working', () => {
    const state = queueOutgoing(followState({ ...chat, state: 'idle' }), { id: 'out-1', text: 'teste', sentAt: started })
    expect(workingStatus(state)).toEqual({ label: 'Thinking', since: started })
  })
})

describe('formatElapsed', () => {
  test('seconds under a minute, then minutes and padded seconds, then hours', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(42_900)).toBe('42s')
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_725_000)).toBe('1h 02m')
  })

  test('a start in the future reads as zero', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})
