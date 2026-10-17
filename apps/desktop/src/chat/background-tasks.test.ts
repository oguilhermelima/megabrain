import { describe, expect, test } from 'bun:test'
import { chatEventLineSchema, type TranscriptEvent } from '@/api/schema'
import { cutLine, runningLabel, runningTasks, taskDurationMs, taskRows, taskStateLabel, type BackgroundTask } from '@/chat/background-tasks'
import { buildConversationItems } from '@/chat/conversation-model'

const cut = (fields: Partial<TranscriptEvent> = {}): TranscriptEvent => ({ id: 'cut', at: '2026-10-17T10:00:05Z', kind: 'turn-cut', text: '', partial: true, reason: 'interrupted', ...fields })

const task = (fields: Partial<BackgroundTask> = {}): BackgroundTask => ({ id: 't1', kind: 'shell', label: 'bun test --watch', state: 'running', startedAt: '2026-10-17T10:00:00Z', ...fields })

const taskEvent = (id: string, fields: Partial<BackgroundTask> = {}): TranscriptEvent => {
  const backgroundTask = task(fields)
  return { id, at: backgroundTask.endedAt ?? backgroundTask.startedAt, kind: 'background-task', text: backgroundTask.label, backgroundTask }
}

describe('cutLine', () => {
  test('names who or what stopped the turn', () => {
    expect(cutLine(cut({ reason: 'interrupted' }))).toBe('Stopped before finishing · you interrupted')
    expect(cutLine(cut({ reason: 'process-exited' }))).toBe('Stopped before finishing · the agent process exited')
    expect(cutLine(cut({ reason: 'limit' }))).toBe('Stopped before finishing · usage limit')
  })

  test('an error says what went wrong when the event does', () => {
    expect(cutLine(cut({ reason: 'error', detail: 'API returned 529 overloaded' }))).toBe('Stopped before finishing · error: API returned 529 overloaded')
    expect(cutLine(cut({ reason: 'error' }))).toBe('Stopped before finishing · error')
    expect(cutLine(cut({ reason: 'error', detail: '  ' }))).toBe('Stopped before finishing · error')
  })

  test('an unknown or missing reason says only that it stopped', () => {
    expect(cutLine(cut({ reason: 'unknown' }))).toBe('Stopped before finishing')
    expect(cutLine(cut({ reason: undefined }))).toBe('Stopped before finishing')
  })
})

describe('taskRows', () => {
  test('keeps the latest state of each task, by its id', () => {
    const { latest } = taskRows([
      taskEvent('a', { id: 't1', state: 'running' }),
      taskEvent('b', { id: 't2', kind: 'monitor', label: 'watch CI', state: 'running' }),
      taskEvent('c', { id: 't1', state: 'completed', endedAt: '2026-10-17T10:01:30Z', exitCode: 0, summary: '12 pass' }),
    ])
    expect(latest.get('t1')).toEqual(task({ id: 't1', state: 'completed', endedAt: '2026-10-17T10:01:30Z', exitCode: 0, summary: '12 pass' }))
    expect(latest.get('t2')?.state).toBe('running')
    expect(latest.size).toBe(2)
  })

  test('shows each task once, where it started', () => {
    const user: TranscriptEvent = { id: 'u', at: null, kind: 'user', text: 'run it' }
    const answer: TranscriptEvent = { id: 'm', at: null, kind: 'assistant', text: 'Started.' }
    const { events } = taskRows([user, taskEvent('a', { id: 't1' }), answer, taskEvent('c', { id: 't1', state: 'failed', exitCode: 1 })])
    expect(events.map((event) => event.id)).toEqual(['u', 'a', 'm'])
  })

  test('a later state fills what it leaves out from the earlier ones', () => {
    const update: TranscriptEvent = { id: 'b', at: null, kind: 'background-task', text: '', backgroundTask: { id: 't1', kind: 'shell', label: '', state: 'killed', startedAt: '' } }
    const { latest } = taskRows([taskEvent('a', { id: 't1', label: 'pnpm dev' }), update])
    expect(latest.get('t1')).toMatchObject({ label: 'pnpm dev', startedAt: '2026-10-17T10:00:00Z', state: 'killed' })
  })

  test('a conversation with no repeated task keeps its events as they are', () => {
    const events = [taskEvent('a', { id: 't1' }), taskEvent('b', { id: 't2' })]
    expect(taskRows(events).events).toBe(events)
    const none: TranscriptEvent[] = [{ id: 'u', at: null, kind: 'user', text: 'hi' }]
    expect(taskRows(none).events).toBe(none)
    expect(taskRows(none).latest.size).toBe(0)
  })
})

describe('runningTasks and runningLabel', () => {
  test('counts only the tasks still running, oldest first', () => {
    const { latest } = taskRows([
      taskEvent('a', { id: 't1', startedAt: '2026-10-17T10:00:10Z' }),
      taskEvent('b', { id: 't2', startedAt: '2026-10-17T10:00:00Z', kind: 'monitor' }),
      taskEvent('c', { id: 't3', state: 'running' }),
      taskEvent('d', { id: 't3', state: 'completed', endedAt: '2026-10-17T10:00:20Z' }),
      taskEvent('e', { id: 't4', state: 'lost' }),
      taskEvent('f', { id: 't5', kind: 'agent', state: 'failed' }),
    ])
    expect(runningTasks(latest).map((running) => running.id)).toEqual(['t2', 't1'])
  })

  test('says how many run in the background', () => {
    expect(runningLabel(1)).toBe('1 running in background')
    expect(runningLabel(2)).toBe('2 running in background')
  })
})

describe('taskStateLabel and taskDurationMs', () => {
  test('names each state', () => {
    expect(taskStateLabel(task({ state: 'running' }))).toBe('running')
    expect(taskStateLabel(task({ state: 'completed', exitCode: 0 }))).toBe('done')
    expect(taskStateLabel(task({ state: 'failed', exitCode: 2 }))).toBe('failed · exit 2')
    expect(taskStateLabel(task({ state: 'failed' }))).toBe('failed')
    expect(taskStateLabel(task({ state: 'killed' }))).toBe('stopped')
    expect(taskStateLabel(task({ state: 'lost' }))).toBe('no longer tracked')
  })

  test('a running task counts to now, an ended one to its end', () => {
    const now = Date.parse('2026-10-17T10:00:42Z')
    expect(taskDurationMs(task({ state: 'running' }), now)).toBe(42_000)
    expect(taskDurationMs(task({ state: 'completed', endedAt: '2026-10-17T10:01:30Z' }), now)).toBe(90_000)
  })

  test('a lost task has no duration unless it ended, and a bad start has none', () => {
    const now = Date.parse('2026-10-17T10:00:42Z')
    expect(taskDurationMs(task({ state: 'lost' }), now)).toBeNull()
    expect(taskDurationMs(task({ state: 'lost', endedAt: '2026-10-17T10:00:30Z' }), now)).toBe(30_000)
    expect(taskDurationMs(task({ startedAt: 'not a date' }), now)).toBeNull()
  })
})

describe('the conversation around a cut turn', () => {
  test('a tool call left without a result by a cut turn reads as failed, not running', () => {
    const items = buildConversationItems([
      { id: 'u', at: null, kind: 'user', text: 'go' },
      { id: 'c', at: null, kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: '{"command":"sleep 60"}' } },
      cut({ id: 'x', partial: false }),
    ])
    expect(items.map((item) => (item.type === 'tool' ? item.status : item.type))).toEqual(['message', 'error', 'message'])
  })
})

describe('the chat event line schema', () => {
  test('reads a cut turn, an unknown reason as unknown', () => {
    const line = chatEventLineSchema.parse({ cursor: '7', event: { id: 'e7', at: '2026-10-17T10:00:05Z', kind: 'turn-cut', type: 'turn-cut', text: '', reason: 'meteor', partial: false } })
    expect(line.event).toMatchObject({ kind: 'turn-cut', reason: 'unknown', partial: false })
  })

  test('reads a background task, an unknown kind as other', () => {
    const line = chatEventLineSchema.parse({
      cursor: '8',
      event: { id: 'e8', at: '2026-10-17T10:00:00Z', kind: 'background-task', text: 'Build', backgroundTask: { id: 'bt1', kind: 'daemon', label: 'Build', state: 'running', startedAt: '2026-10-17T10:00:00Z' } },
    })
    expect(line.event).toMatchObject({ kind: 'background-task', backgroundTask: { id: 'bt1', kind: 'other', state: 'running' } })
  })
})
