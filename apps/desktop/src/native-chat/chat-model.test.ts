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
  formatTokens,
  liveTail,
  markAnswered,
  modeToggle,
  pendingApproval,
  queueOutgoing,
  resumableChatState,
  rowStatus,
  shouldInterrupt,
  thinkingProgress,
  withModel,
  withSwitchResult,
  workingStatus,
  type FollowState,
} from '@/native-chat/chat-model'

describe('resumable chats', () => {
  test('a message can resume suspended, stopped and holder-error chats', () => {
    expect(['suspended', 'stopped', 'error'].map((state) => resumableChatState(state as NativeChat['state']))).toEqual([true, true, true])
    expect(['starting', 'idle', 'working', 'waiting-approval'].map((state) => resumableChatState(state as NativeChat['state']))).toEqual([false, false, false, false])
  })
})

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
  test('chat to terminal is offered in every state', () => {
    for (const state of ['idle', 'working', 'waiting-approval', 'starting', 'suspended', 'stopped', 'error'] as const) {
      expect(modeToggle({ ...chat, state })).toEqual({ target: 'terminal', enabled: true, reason: null })
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
    expect(rowStatus('suspended')).toBe('ended')
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

  test('thinking chunks show no row of their own; the working indicator says Thinking', () => {
    let state = followState(chat)
    state = applyLine(state, delta('1', 't1', 'Reading the', 'thinking'))
    state = applyLine(state, delta('1', 'm1', 'Done'))
    state = applyLine(state, delta('1', 't1', ' steps', 'thinking'))
    expect(tailTexts(state)).toEqual(['assistant:Done'])
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

describe('thinking', () => {
  const started = '2026-10-15T12:00:00Z'
  const call = (cursor: string, id: string): ChatEventLine => line(cursor, { event: { id, at: null, kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: 'ls' } } })
  const result = (cursor: string, id: string): ChatEventLine => line(cursor, { event: { id, at: null, kind: 'tool-result', text: 'ok', tool: { name: 'Bash', status: 'ok' } } })
  const thinkingRows = (state: FollowState) => liveTail(state).filter((row) => row.event.kind === 'thinking').length

  test('a message streams its text after its thinking, even when both carry one message id', () => {
    let state = applyLine(followState(chat), stateLine('1', 'working', started))
    state = applyLine(state, delta('1', 'msg_1', 'Let me see', 'thinking'))
    state = applyLine(state, delta('1', 'msg_1', 'Here it is'))
    expect(tailTexts(state)).toEqual(['assistant:Here it is'])
    expect(workingStatus(state)?.label).toBe('Writing')
  })

  test('the complete thinking event ends only the thinking of its message', () => {
    let state = applyLine(followState(chat), stateLine('1', 'working', started))
    state = applyLine(state, delta('1', 'msg_1', 'Let me see', 'thinking'))
    state = applyLine(state, final('2', 'th1', 'msg_1', 'Let me see', 'thinking'))
    state = applyLine(state, delta('2', 'msg_1', 'Here it is'))
    expect(tailTexts(state)).toEqual(['assistant:Here it is'])
  })

  // Claude 5 streams thinking chunks but its complete message carries an empty thinking block (only a
  // signature), so no complete thinking event ever comes, and its tool calls carry no message id.
  test('a long turn whose thinking never completes leaves no rows and says what runs now', () => {
    let state = applyLine(followState(chat), stateLine('1', 'working', started))
    const lines: ChatEventLine[] = []
    for (let cycle = 1; cycle <= 4; cycle++) {
      lines.push(delta(String(cycle * 2), `msg_${cycle}`, `Checking ${cycle}`, 'thinking'))
      lines.push(call(String(cycle * 2), `c${cycle}`))
      lines.push(result(String(cycle * 2 + 1), `r${cycle}`))
    }
    lines.push(delta('9', 'msg_5', 'Wrapping up', 'thinking'))
    // A follow that reconnects in the middle replays from an older cursor, starting with the chat state.
    const replay = [stateLine('5', 'working', started), ...lines.slice(0, 6)]
    for (const next of [...lines.slice(0, 6), ...replay, ...lines.slice(6)]) {
      const replayed = replay.includes(next)
      state = applyLine(state, next)
      expect(thinkingRows(state)).toBe(0)
      if (!replayed && next.event?.kind === 'tool-call') expect(workingStatus(state)?.label).toBe('Running Bash')
      if (!replayed && next.event?.kind === 'delta') expect(workingStatus(state)?.label).toBe('Thinking')
    }
    expect(state.events.map((item) => item.id)).toEqual(['c1', 'r1', 'c2', 'r2', 'c3', 'r3', 'c4', 'r4'])
    expect(liveTail(state)).toEqual([])
    state = applyLine(state, stateLine('10', 'idle'))
    expect(liveTail(state)).toEqual([])
    expect(workingStatus(state)).toBeNull()
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

  test('the chat record at the head of a resumed follow replaces the one the view kept', () => {
    let state = applyLine(followState({ ...chat, state: 'idle' }), line('207', { event: event('e207') }))
    state = applyLine(state, line('207', { chat: { ...chat, state: 'working', title: 'Retitled' } }))
    expect(state.chat?.state).toBe('working')
    expect(state.chat?.title).toBe('Retitled')
    expect(state.cursor).toBe('207')
    expect(applyLine(state, line('206', { chat: { ...chat, state: 'idle' } })).chat?.state).toBe('working')
  })

  test('a line whose event this app does not read still moves the cursor', () => {
    const state = applyLine(followState(chat), line('128', { event: event('e128') }))
    expect(applyLine(state, line('129')).cursor).toBe('129')
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

  test('a message with one image shows it once while pending and once after the echo', () => {
    const image = { path: '/tmp/a/shot.png' }
    const parts = [{ type: 'image' as const, path: image.path }, { type: 'text' as const, text: 'teste' }]
    let state = queueOutgoing(followState({ ...chat, state: 'idle' }), { ...sent, images: [image], parts })
    const pending = liveTail(state)[0]?.event
    expect(pending?.images).toEqual([image])
    expect(pending?.parts).toEqual(parts)
    state = applyLine(state, line('1', { event: { id: 'u1', at: null, kind: 'user', text: 'teste', images: [image], parts } }))
    expect(liveTail(state)).toEqual([])
    const users = state.events.filter((item) => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]?.images).toEqual([image])
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

  test('a running tool names itself so the indicator shows its icon, not the agent mark', () => {
    const call: TranscriptEvent = { id: 'c1', at: null, kind: 'tool-call', text: 'mcp__github__get_pr', tool: { name: 'mcp__github__get_pr', input: '{}' } }
    expect(workingStatus(working([line('2', { event: call })]))?.tool).toBe('mcp__github__get_pr')
    expect(workingStatus(working([delta('1', 'm1', 'Here')]))?.tool).toBeUndefined()
    expect(workingStatus(working([]))?.tool).toBeUndefined()
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

  test('a starting state never carries the timestamp of an earlier turn', () => {
    const state = applyLine(working([]), stateLine('2', 'starting'))
    expect(state.turnStartedAt).toBeNull()
    expect(workingStatus({ ...state, chat: { ...chat, state: 'starting', createdAt: '2026-10-14T08:00:00Z' } })?.since).toBe('2026-10-14T08:00:00Z')
  })

  test('a start older than the newest event is ignored, so a chat made yesterday shows no hours', () => {
    const created = { ...chat, state: 'starting' as const, createdAt: '2026-10-15T00:00:00Z' }
    const reply: TranscriptEvent = { id: 'a1', at: '2026-10-16T12:00:00Z', kind: 'assistant', text: 'done' }
    const state = applyLine(followState({ ...created, state: 'idle' }), line('1', { event: reply }))
    expect(workingStatus(applyLine(state, stateLine('2', 'starting')))?.since ?? null).toBeNull()
  })

  test('a chat that already talked reconnects quietly, with no clock', () => {
    const talked = { ...chat, state: 'idle' as const, agentSessionId: 'session-1', createdAt: '2026-10-15T00:00:00Z' }
    const reply: TranscriptEvent = { id: 'a1', at: '2026-10-16T12:00:00Z', kind: 'assistant', text: 'done' }
    const state = applyLine(applyLine(followState(talked), line('1', { event: reply })), stateLine('2', 'starting'))
    expect(workingStatus(state)).toEqual({ label: 'Reconnecting…', since: null })
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

describe('the chat state after a switch', () => {
  // The real chat the person saw: its last lines are idle (13), starting (14) and idle (15).
  const talked: NativeChat = { ...chat, state: 'idle', mode: 'terminal', agentSessionId: 'session-1', createdAt: '2026-10-15T00:00:00Z' }
  const reply: TranscriptEvent = { id: 'a1', at: '2026-10-16T15:40:00Z', kind: 'assistant', text: 'done' }
  const inTerminal = () => applyLine(applyLine(followState(talked), line('12', { event: reply })), stateLine('13', 'idle'))
  // The mode call answers with the record as it was when the agent was told to start.
  const switched: NativeChat = { ...talked, mode: 'chat', state: 'starting' }

  test('the mode answer arriving after the follow saw idle leaves the chat idle, not reconnecting', () => {
    const followed = [stateLine('14', 'starting'), stateLine('15', 'idle')].reduce(applyLine, inTerminal())
    const state = withSwitchResult(followed, switched)
    expect(state.chat?.state).toBe('idle')
    expect(state.chat?.mode).toBe('chat')
    expect(workingStatus(state)).toBeNull()
  })

  test('the mode answer arriving before the follow lines ends idle once they land', () => {
    const answered = withSwitchResult(inTerminal(), switched)
    expect(answered.chat?.mode).toBe('chat')
    const state = [stateLine('14', 'starting'), stateLine('15', 'idle')].reduce(applyLine, answered)
    expect(state.chat?.state).toBe('idle')
    expect(workingStatus(state)).toBeNull()
  })

  test('the mode answer in the middle of the sequence still ends idle', () => {
    const answered = withSwitchResult(applyLine(inTerminal(), stateLine('14', 'starting')), switched)
    const state = applyLine(answered, stateLine('15', 'idle'))
    expect(workingStatus(state)).toBeNull()
  })

  test('a follow restarted after the switch takes the start-of-follow state at its own cursor', () => {
    const followed = [stateLine('14', 'starting'), stateLine('15', 'idle')].reduce(applyLine, inTerminal())
    const stale = { ...followed, chat: { ...switched } }
    const resumed = applyLine(applyLine(stale, line('15', { chat: { ...talked, mode: 'chat' } })), stateLine('15', 'idle'))
    expect(workingStatus(resumed)).toBeNull()
  })

  test('an app restart replays the history and ends idle', () => {
    const history = [line('0', { chat: { ...talked, mode: 'chat' } }), line('12', { event: reply }), stateLine('13', 'idle'), stateLine('14', 'starting'), stateLine('15', 'idle'), stateLine('15', 'idle')]
    const state = history.reduce(applyLine, followState(null))
    expect(state.chat?.state).toBe('idle')
    expect(workingStatus(state)).toBeNull()
  })

  test('before any follow line the mode answer is taken whole', () => {
    expect(withSwitchResult(followState(null), switched).chat).toEqual(switched)
  })
})

describe('images in sent messages', () => {
  const image = { path: '/state/attachments/shot.png' }

  test('a message just sent shows its images at once', () => {
    const state = queueOutgoing(followState({ ...chat, state: 'idle' }), { id: 'out-1', text: 'look', sentAt: '2026-10-16T12:00:00Z', images: [image] })
    expect(liveTail(state)[0]?.event.images).toEqual([image])
  })

  test('a message without images carries none', () => {
    const state = queueOutgoing(followState({ ...chat, state: 'idle' }), { id: 'out-1', text: 'look', sentAt: '2026-10-16T12:00:00Z' })
    expect(liveTail(state)[0]?.event.images).toBeUndefined()
  })

  test('the stored user event keeps the images the daemon recorded', () => {
    const sent: TranscriptEvent = { id: 'u1', at: '2026-10-16T12:00:01Z', kind: 'user', text: 'look', images: [image] }
    const queued = queueOutgoing(followState({ ...chat, state: 'idle' }), { id: 'out-1', text: 'look', sentAt: '2026-10-16T12:00:00Z', images: [image] })
    const state = applyLine(queued, line('1', { event: sent }))
    expect(state.outgoing).toEqual([])
    expect(state.events.at(-1)?.images).toEqual([image])
  })
})

describe('thinkingProgress', () => {
  const started = '2026-10-15T12:00:00Z'
  const at = (seconds: number) => new Date(Date.parse(started) + seconds * 1000).toISOString()
  const ms = (seconds: number) => Date.parse(started) + seconds * 1000
  const working = (lines: ChatEventLine[], agent: NativeChat['agent'] = 'claude') => lines.reduce(applyLine, applyLine(followState({ ...chat, agent, state: 'idle' }), stateLine('1', 'working', started)))
  const progress = (seconds: number, value: { tokens?: number; retry?: { attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string }; status?: string }): ChatEventLine => ({ cursor: '', event: { kind: 'progress', at: at(seconds), progress: value } })
  const thinkingAt = (seconds: number, text: string): ChatEventLine => ({ cursor: '', event: { kind: 'delta', stream: 'thinking', messageId: 't1', text, at: at(seconds) } })

  test('nothing outside a turn', () => {
    expect(thinkingProgress(followState({ ...chat, state: 'idle' }), ms(0))).toBeNull()
  })

  test('the turn has no count until the agent reports one, then the latest', () => {
    expect(thinkingProgress(working([]), ms(1))?.tokens).toBeNull()
    expect(thinkingProgress(working([progress(2, { tokens: 50 }), progress(3, { tokens: 2300 })]), ms(3))?.tokens).toBe(2300)
  })

  test('tokens arriving pulse; a quiet second and a half later they do not', () => {
    const state = working([progress(2, { tokens: 50 })])
    expect(thinkingProgress(state, ms(2.5))?.receiving).toBe(true)
    expect(thinkingProgress(state, ms(4))?.receiving).toBe(false)
  })

  test('Claude with nothing arriving for 15 seconds is waiting for the API, counted from the last sign of life', () => {
    expect(thinkingProgress(working([]), ms(14))?.waiting).toBe(false)
    expect(thinkingProgress(working([]), ms(15))?.waiting).toBe(true)
    expect(thinkingProgress(working([progress(10, { tokens: 50 })]), ms(20))?.waiting).toBe(false)
    expect(thinkingProgress(working([thinkingAt(10, 'Checking')]), ms(26))?.waiting).toBe(true)
  })

  test('a running tool or a Codex turn is never waiting for the API: neither streams while it works', () => {
    const call: TranscriptEvent = { id: 'c1', at: at(1), kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: 'sleep 60' } }
    expect(thinkingProgress(working([line('2', { event: call })]), ms(60))?.waiting).toBe(false)
    expect(thinkingProgress(working([], 'codex'), ms(60))?.waiting).toBe(false)
  })

  test('a retry is a notice until tokens or text arrive again', () => {
    const retrying = working([progress(2, { tokens: 50 }), progress(3, { retry: { attempt: 2, maxAttempts: 10, delayMs: 4000, reason: 'overloaded' } })])
    expect(thinkingProgress(retrying, ms(4))?.notice).toBe('Retrying, attempt 2 of 10: overloaded')
    expect(thinkingProgress(applyLine(retrying, progress(8, { tokens: 80 })), ms(8))?.notice).toBeNull()
    expect(thinkingProgress(applyLine(retrying, thinkingAt(8, 'Back')), ms(8))?.notice).toBeNull()
    expect(thinkingProgress(working([progress(3, { retry: { reason: 'Reconnecting... 1/5' } })], 'codex'), ms(4))?.notice).toBe('Retrying: Reconnecting... 1/5')
  })

  test('compacting is a notice while it lasts', () => {
    expect(thinkingProgress(working([progress(2, { status: 'compacting' })]), ms(3))?.notice).toBe('Compacting the conversation')
    expect(thinkingProgress(working([progress(2, { status: 'compacting' }), progress(9, { status: 'requesting' })]), ms(9))?.notice).toBeNull()
  })

  test('the thinking text streaming now, and none when the stream carries none', () => {
    expect(thinkingProgress(working([thinkingAt(2, 'There'), thinkingAt(3, ' are 62')]), ms(3))?.thinking).toBe('There are 62')
    expect(thinkingProgress(working([thinkingAt(2, '')]), ms(3))?.thinking).toBeNull()
    expect(thinkingProgress(working([progress(2, { tokens: 50 })]), ms(3))?.thinking).toBeNull()
  })

  test('a new turn starts with no count and no notice', () => {
    const ended = applyLine(working([progress(2, { tokens: 900, retry: { reason: 'x' } })]), stateLine('2', 'idle'))
    const next = applyLine(ended, stateLine('3', 'working', at(30)))
    expect(thinkingProgress(next, ms(31))).toMatchObject({ tokens: null, notice: null })
  })

  test('counts read the way Claude Code shows them', () => {
    expect([formatTokens(0), formatTokens(850), formatTokens(1000), formatTokens(2340), formatTokens(12_400), formatTokens(1_250_000)]).toEqual(['0 tokens', '850 tokens', '1k tokens', '2.3k tokens', '12.4k tokens', '1.3M tokens'])
  })
})
