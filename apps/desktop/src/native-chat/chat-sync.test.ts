import { describe, expect, test } from 'bun:test'
import type { ChatQueueChange } from '@/api/adapter'
import type { ChatEventLine, ChatQueueItem, NativeChat } from '@/api/schema'
import { applyLine, followState, workingStatus, type FollowState } from '@/native-chat/chat-model'
import { changeChatQueue, startChatSync, CHECK_MS, type SyncApi } from '@/native-chat/chat-sync'

const chat: NativeChat = {
  id: 'chat-1',
  agent: 'claude',
  model: null,
  cwd: '/work/repo',
  title: 'Plan the lanes',
  state: 'idle',
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-17T02:00:00Z',
  lastActivityAt: '2026-10-17T02:11:49Z',
}
const item: ChatQueueItem = { id: '31f250d5', parts: [{ type: 'text', text: 'consegue abrir o app usando o maestro?' }], createdAt: '2026-10-17T02:05:00Z', updatedAt: '2026-10-17T02:05:00Z' }
const assistant = (cursor: string): ChatEventLine => ({ cursor, event: { id: `e${cursor}`, at: null, kind: 'assistant', text: cursor } })

// Timers the test fires by hand, in the order they would come due.
function manualTimers() {
  let now = 0
  let next = 0
  const pending = new Map<number, { at: number; run: () => void }>()
  return {
    set: (run: () => void, ms: number) => {
      next += 1
      pending.set(next, { at: now + ms, run })
      return next
    },
    clear: (handle: unknown) => void pending.delete(handle as number),
    /** Moves the clock and runs every timer that came due, including ones they set. */
    advance: async (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        pending.delete(due[0])
        now = due[1].at
        due[1].run()
        await flush()
      }
      now = until
      await flush()
    },
    delays: () => [...pending.values()].map((timer) => timer.at - now),
  }
}
const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

// A daemon stand-in: each follow is recorded, and a read answers with what the daemon holds now.
function fakeDaemon() {
  const follows: { since: string | null; onLine: (line: ChatEventLine) => void; onEnd: (error: string | null) => void; closed: boolean }[] = []
  const reads: (string | null)[] = []
  let failNext: unknown = null
  let stored: ChatEventLine[] = []
  let head: ChatEventLine = { cursor: '0', chat, queue: [] }
  const api: SyncApi = {
    followChat: async (_chatId, since, onLine, onEnd) => {
      if (failNext !== null) {
        const caught = failNext
        failNext = null
        throw caught
      }
      const follow = { since, onLine, onEnd: onEnd ?? (() => {}), closed: false }
      follows.push(follow)
      return () => {
        follow.closed = true
      }
    },
    chatEvents: async (_chatId, since) => {
      reads.push(since)
      const after = since === null ? 0 : Number(since)
      return [{ ...head, cursor: String(after) }, ...stored.filter((line) => Number(line.cursor) > after)]
    },
  }
  return {
    api,
    follows,
    reads,
    failFollow: (caught: unknown) => {
      failNext = caught
    },
    advance: (lines: ChatEventLine[], now: Partial<ChatEventLine>) => {
      stored = stored.concat(lines)
      head = { ...head, ...now }
    },
  }
}

// The view's side: lines fold into a follow state, the queue rides on its own lines.
function view(start: FollowState = followState(chat)) {
  let state = start
  let queue: ChatQueueItem[] = []
  const reconnecting: (string | null)[] = []
  return {
    onLine: (line: ChatEventLine) => {
      if (line.queue !== undefined) queue = line.queue
      state = applyLine(state, line)
    },
    onReconnecting: (reason: string | null) => reconnecting.push(reason),
    cursor: () => state.cursor,
    state: () => state,
    queue: () => queue,
    setQueue: (items: ChatQueueItem[]) => {
      queue = items
    },
    reconnecting,
  }
}

describe('the chat view stays in step with the daemon', () => {
  test('a follow started after a relaunch resumes after the last cursor the view applied', async () => {
    const daemon = fakeDaemon()
    const shown = view(applyLine(followState(chat), assistant('207')))
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => true })
    await flush()
    expect(daemon.follows.map((follow) => follow.since)).toEqual(['207'])
    sync.stop()
  })

  test('a follow that ends comes back with backoff from the cursor reached, showing Reconnecting meanwhile', async () => {
    const daemon = fakeDaemon()
    const shown = view()
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => false })
    await flush()
    daemon.follows[0]?.onLine(assistant('5'))
    daemon.follows[0]?.onEnd('chatd is not running')
    expect(shown.reconnecting.at(-1)).toBe('chatd is not running')
    await timers.advance(300)
    expect(daemon.follows.map((follow) => follow.since)).toEqual([null, '5'])
    // A refused follow is retried too, after twice as long.
    daemon.failFollow(new Error('could not run megabrain'))
    daemon.follows[1]?.onEnd(null)
    await timers.advance(600)
    expect(daemon.follows).toHaveLength(2)
    expect(shown.reconnecting.at(-1)).toBe('could not run megabrain')
    await timers.advance(1200)
    expect(daemon.follows.map((follow) => follow.since)).toEqual([null, '5', '5'])
    daemon.follows[2]?.onLine({ cursor: '5', chat })
    expect(shown.reconnecting.at(-1)).toBeNull()
    sync.stop()
  })

  test('a follow that stays open but goes silent while the daemon advances converges within one check', async () => {
    const daemon = fakeDaemon()
    const shown = view()
    shown.setQueue([item])
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => true })
    await flush()
    daemon.follows[0]?.onLine({ cursor: '0', chat, queue: [item] })
    daemon.follows[0]?.onLine(assistant('207'))
    // The daemon takes the queued message and starts its turn; the follow delivers none of it.
    daemon.advance(
      [
        { cursor: '208', event: { id: 's208', at: null, kind: 'state', text: 'idle' } },
        { cursor: '209', event: { id: 'e209', at: null, kind: 'user', text: 'consegue abrir o app usando o maestro?' } },
        { cursor: '210', event: { id: 's210', at: null, kind: 'state', text: 'working', turnStartedAt: '2026-10-17T02:11:51Z' } },
      ],
      { chat: { ...chat, state: 'working' }, queue: [] },
    )
    await timers.advance(CHECK_MS)
    expect(daemon.reads).toEqual(['207'])
    expect(shown.queue()).toEqual([])
    expect(shown.state().cursor).toBe('210')
    expect(shown.state().chat?.state).toBe('working')
    expect(workingStatus(shown.state())).not.toBeNull()
    // The silent follow is replaced by one from where the view now is.
    await timers.advance(CHECK_MS)
    expect(daemon.follows[0]?.closed).toBe(true)
    expect(daemon.follows.at(-1)?.since).toBe('210')
    sync.stop()
  })

  test('a live follow that delivers what a check saw is kept', async () => {
    const daemon = fakeDaemon()
    const shown = view()
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => true })
    await flush()
    daemon.follows[0]?.onLine({ cursor: '0', chat })
    daemon.advance([assistant('1')], {})
    await timers.advance(CHECK_MS)
    daemon.follows[0]?.onLine(assistant('1'))
    await timers.advance(CHECK_MS)
    expect(daemon.follows).toHaveLength(1)
    expect(daemon.follows[0]?.closed).toBe(false)
    sync.stop()
  })

  test('no check runs while the chat is hidden, and one runs at once when asked', async () => {
    const daemon = fakeDaemon()
    const shown = view()
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => false })
    await flush()
    await timers.advance(CHECK_MS * 3)
    expect(daemon.reads).toEqual([])
    await sync.check()
    expect(daemon.reads).toEqual([null])
    sync.stop()
  })

  test('a stopped sync follows no more and retries nothing', async () => {
    const daemon = fakeDaemon()
    const shown = view()
    const timers = manualTimers()
    const sync = startChatSync({ chatId: chat.id, api: daemon.api, cursor: shown.cursor, onLine: shown.onLine, onReconnecting: shown.onReconnecting, timers, visible: () => true })
    await flush()
    sync.stop()
    expect(daemon.follows[0]?.closed).toBe(true)
    daemon.follows[0]?.onEnd(null)
    await timers.advance(CHECK_MS * 3)
    expect(daemon.follows).toHaveLength(1)
    expect(daemon.reads).toEqual([])
  })
})

describe('a queue change on a message the daemon already took', () => {
  const queueApi = (refusal: string | null) => {
    const calls: ChatQueueChange[] = []
    return {
      calls,
      api: {
        chatQueue: async (_chatId: string, change: ChatQueueChange) => {
          calls.push(change)
          if (change.action !== 'list' && refusal !== null) throw new Error(refusal)
          return []
        },
      },
    }
  }

  test.each(['send-now', 'remove'] as const)('%s refreshes the queue and says nothing', async (action) => {
    const { api, calls } = queueApi(`message ${item.id} is not in the queue`)
    expect(await changeChatQueue(api, chat.id, { action, itemId: item.id })).toEqual({ items: [], taken: true })
    expect(calls.map((call) => call.action)).toEqual([action, 'list'])
  })

  test('an edit says it was taken, so the composer keeps the text', async () => {
    const { api } = queueApi(`message ${item.id} is not in the queue`)
    expect(await changeChatQueue(api, chat.id, { action: 'edit', itemId: item.id, parts: item.parts })).toEqual({ items: [], taken: true })
  })

  test('any other refusal still fails', async () => {
    const { api } = queueApi('chatd is not running')
    expect(changeChatQueue(api, chat.id, { action: 'remove', itemId: item.id })).rejects.toThrow('chatd is not running')
  })

  test('a change that lands answers with the queue', async () => {
    const { api, calls } = queueApi(null)
    expect(await changeChatQueue(api, chat.id, { action: 'remove', itemId: item.id })).toEqual({ items: [], taken: false })
    expect(calls).toHaveLength(1)
  })
})
