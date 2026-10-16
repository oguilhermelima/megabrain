import { describe, expect, test } from 'bun:test'
import { createLiveRead } from '@/lib/live-read'
import type { SharedReadCache, SharedReadClock } from '@/lib/shared-read'

function fakeClock() {
  let now = 0
  let timers: { at: number; run: () => void }[] = []
  const clock: SharedReadClock = {
    now: () => now,
    visible: () => true,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run }
      timers.push(timer)
      return () => {
        timers = timers.filter((item) => item !== timer)
      }
    },
  }
  return {
    clock,
    advance: async (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at)[0]
        if (due === undefined) break
        timers = timers.filter((timer) => timer !== due)
        now = due.at
        due.run()
        await settle()
      }
      now = until
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function memoryCache<T>(entry: { value: T; savedAt: number } | null): SharedReadCache<T> {
  let held = entry
  return { load: () => held, save: (next) => void (held = next) }
}

describe('createLiveRead', () => {
  test('start reads once at app start and every pane then shares that one read', async () => {
    const time = fakeClock()
    let calls = 0
    const live = createLiveRead(async () => ++calls, { clock: time.clock })
    const stop = live.start()
    const paneA = live.subscribe(() => {})
    const paneB = live.subscribe(() => {})
    await settle()
    expect(calls).toBe(1)
    expect(live.get()).toBe(1)
    paneA()
    paneB()
    stop()
  })

  test('reads on its own without any pane, about every minute', async () => {
    const time = fakeClock()
    let calls = 0
    const live = createLiveRead(async () => ++calls, { clock: time.clock })
    const stop = live.start()
    await settle()
    await time.advance(60_000)
    expect(calls).toBe(2)
    stop()
  })

  test('the last known value and its age are there before the first read ends', () => {
    const time = fakeClock()
    const live = createLiveRead(() => new Promise<number>(() => {}), { clock: time.clock, cache: memoryCache({ value: 23, savedAt: 1000 }) })
    live.start()
    expect(live.get()).toBe(23)
    expect(live.readAt()).toBe(1000)
    expect(live.failed()).toBe(false)
  })

  test('a window focus reads again once the interval has passed, and not before', async () => {
    const time = fakeClock()
    let calls = 0
    const live = createLiveRead(async () => ++calls, { clock: time.clock })
    const stop = live.start()
    await settle()
    live.focused()
    await settle()
    expect(calls).toBe(1)
    await time.advance(59_000)
    live.focused()
    await settle()
    expect(calls).toBe(1)
    await time.advance(2_000)
    expect(calls).toBe(2)
    stop()
  })

  test('a failed read keeps the last value, says so, and retries within seconds', async () => {
    const time = fakeClock()
    let calls = 0
    const live = createLiveRead(
      async () => {
        calls += 1
        if (calls === 2) throw new Error('cli down')
        return calls
      },
      { clock: time.clock },
    )
    const changes: boolean[] = []
    live.onChange(() => changes.push(live.failed()))
    const stop = live.start()
    await settle()
    await time.advance(60_000)
    expect(live.get()).toBe(1)
    expect(live.failed()).toBe(true)
    expect(changes).toContain(true)
    await time.advance(10_000)
    expect(calls).toBe(3)
    expect(live.get()).toBe(3)
    expect(live.failed()).toBe(false)
    stop()
  })

  test('a failure before any value shows failed with nothing to show', async () => {
    const time = fakeClock()
    const live = createLiveRead(async () => Promise.reject(new Error('cli down')), { clock: time.clock })
    const stop = live.start()
    await settle()
    expect(live.get()).toBeNull()
    expect(live.failed()).toBe(true)
    stop()
  })
})
