import { describe, expect, test } from 'bun:test'
import { createSharedRead, isStale, staleAfterMs, storageCache, type SharedReadClock } from '@/lib/shared-read'

// A clock the test moves by hand: timers fire only when `advance` passes them.
function fakeClock() {
  let now = 0
  let visible = true
  let timers: { at: number; run: () => void }[] = []
  const clock: SharedReadClock = {
    now: () => now,
    visible: () => visible,
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
    setVisible: (next: boolean) => {
      visible = next
    },
    advance: async (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at)[0]
        if (due === undefined) break
        timers = timers.filter((timer) => timer !== due)
        now = due.at
        due.run()
        await Promise.resolve()
      }
      now = until
      await Promise.resolve()
    },
    pending: () => timers.length,
  }
}

function counter() {
  let calls = 0
  return {
    read: async () => {
      calls += 1
      return calls
    },
    calls: () => calls,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSharedRead', () => {
  test('reload reads at once inside the interval, and once more after a read that was running', async () => {
    const time = fakeClock()
    let release: (value: number) => void = () => {}
    let calls = 0
    const read = () => {
      calls += 1
      return new Promise<number>((resolve) => {
        release = resolve
      })
    }
    const store = createSharedRead(read, { intervalMs: 60_000, clock: time.clock })
    store.subscribe(() => {})
    expect(calls).toBe(1)
    store.reload()
    expect(calls).toBe(1)
    release(1)
    await settle()
    expect(calls).toBe(2)
    release(2)
    await settle()
    expect(store.get()).toBe(2)
    store.refresh()
    expect(calls).toBe(2)
    store.reload()
    expect(calls).toBe(3)
  })

  test('every subscriber shares one read and gets its value', async () => {
    const time = fakeClock()
    const source = counter()
    const store = createSharedRead(source.read, { intervalMs: 60_000, clock: time.clock })
    const seen: number[] = []
    const stopA = store.subscribe((value) => seen.push(value))
    const stopB = store.subscribe((value) => seen.push(value * 10))
    await settle()
    expect(source.calls()).toBe(1)
    expect(store.get()).toBe(1)
    expect(seen.sort()).toEqual([1, 10])
    stopA()
    stopB()
  })

  test('at most one read per interval, however often it is asked', async () => {
    const time = fakeClock()
    const source = counter()
    const store = createSharedRead(source.read, { intervalMs: 60_000, clock: time.clock })
    const stop = store.subscribe(() => {})
    await settle()
    await time.advance(30_000)
    store.refresh()
    store.subscribe(() => {})()
    await settle()
    expect(source.calls()).toBe(1)
    await time.advance(30_000)
    await settle()
    expect(source.calls()).toBe(2)
    stop()
  })

  test('a read in flight is not started twice', async () => {
    const time = fakeClock()
    let resolve: (value: number) => void = () => {}
    let calls = 0
    const store = createSharedRead(
      () => {
        calls += 1
        return new Promise<number>((done) => {
          resolve = done
        })
      },
      { intervalMs: 0, clock: time.clock },
    )
    const stop = store.subscribe(() => {})
    store.refresh()
    store.refresh()
    expect(calls).toBe(1)
    resolve(1)
    await settle()
    stop()
  })

  test('hidden, it reads nothing; shown again, it reads once if the last read is stale', async () => {
    const time = fakeClock()
    const source = counter()
    const store = createSharedRead(source.read, { intervalMs: 60_000, clock: time.clock })
    const stop = store.subscribe(() => {})
    await settle()
    time.setVisible(false)
    await time.advance(180_000)
    await settle()
    expect(source.calls()).toBe(1)
    time.setVisible(true)
    store.visibilityChanged()
    await settle()
    expect(source.calls()).toBe(2)
    stop()
  })

  test('shown again before the interval passes, it waits for the rest of it', async () => {
    const time = fakeClock()
    const source = counter()
    const store = createSharedRead(source.read, { intervalMs: 60_000, clock: time.clock })
    const stop = store.subscribe(() => {})
    await settle()
    time.setVisible(false)
    store.visibilityChanged()
    await time.advance(20_000)
    time.setVisible(true)
    store.visibilityChanged()
    await settle()
    expect(source.calls()).toBe(1)
    await time.advance(40_000)
    await settle()
    expect(source.calls()).toBe(2)
    stop()
  })

  test('with no subscriber left, no timer stays behind', async () => {
    const time = fakeClock()
    const store = createSharedRead(counter().read, { intervalMs: 60_000, clock: time.clock })
    const stop = store.subscribe(() => {})
    await settle()
    stop()
    expect(time.pending()).toBe(0)
  })

  test('a failed read keeps the last value', async () => {
    const time = fakeClock()
    let fail = false
    const store = createSharedRead(
      async () => {
        if (fail) throw new Error('offline')
        return 7
      },
      { intervalMs: 60_000, clock: time.clock },
    )
    const stop = store.subscribe(() => {})
    await settle()
    fail = true
    await time.advance(60_000)
    await settle()
    expect(store.get()).toBe(7)
    stop()
  })
})

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    items,
  }
}

const throwing = {
  getItem: (): string | null => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('quota')
  },
}

const numberOnly = (raw: unknown) => (typeof raw === 'number' ? raw : null)

describe('storageCache', () => {
  test('a saved value comes back with the time it was read, under a versioned key', () => {
    const storage = memoryStorage()
    const cache = storageCache(() => storage, 'composer.settings', 2, numberOnly)
    cache.save({ value: 7, savedAt: 1_000 })
    expect([...storage.items.keys()]).toEqual(['composer.settings.v2'])
    expect(cache.load()).toEqual({ value: 7, savedAt: 1_000 })
  })

  test('another version, corrupt JSON or the wrong shape reads as nothing', () => {
    const entries: Record<string, string> = {
      old: JSON.stringify({ value: 7, savedAt: 1_000 }),
      corrupt: '{"value": 7, "saved',
      shape: JSON.stringify({ value: 'seven', savedAt: 1_000 }),
      time: JSON.stringify({ value: 7, savedAt: 'yesterday' }),
      empty: 'null',
    }
    expect(storageCache(() => memoryStorage({ 'k.v1': entries.old ?? '' }), 'k', 2, numberOnly).load()).toBeNull()
    for (const key of ['corrupt', 'shape', 'time', 'empty']) {
      expect(storageCache(() => memoryStorage({ 'k.v1': entries[key] ?? '' }), 'k', 1, numberOnly).load()).toBeNull()
    }
  })

  test('storage that throws, or none at all, neither breaks a load nor a save', () => {
    for (const storage of [() => throwing, () => null, () => { throw new Error('no storage') }]) {
      const cache = storageCache(storage, 'k', 1, numberOnly)
      expect(cache.load()).toBeNull()
      expect(() => cache.save({ value: 1, savedAt: 0 })).not.toThrow()
    }
  })
})

describe('isStale', () => {
  test('a value is stale only once it is older than ten minutes', () => {
    expect(staleAfterMs).toBe(10 * 60_000)
    expect(isStale(0, staleAfterMs)).toBe(false)
    expect(isStale(0, staleAfterMs + 1)).toBe(true)
    expect(isStale(5_000, 6_000)).toBe(false)
    expect(isStale(null, 1e12)).toBe(false)
  })
})

describe('createSharedRead with a cache', () => {
  test('the last good value shows before the first read, then the read replaces and saves it', async () => {
    const time = fakeClock()
    await time.advance(900_000)
    const storage = memoryStorage()
    const cache = storageCache(() => storage, 'k', 1, numberOnly)
    cache.save({ value: 41, savedAt: 100_000 })
    let resolve: (value: number) => void = () => {}
    const store = createSharedRead(() => new Promise<number>((done) => (resolve = done)), { intervalMs: 60_000, clock: time.clock, cache })
    expect(store.get()).toBe(41)
    expect(store.readAt()).toBe(100_000)
    const stop = store.subscribe(() => {})
    expect(store.get()).toBe(41)
    resolve(42)
    await settle()
    expect(store.get()).toBe(42)
    expect(store.readAt()).toBe(900_000)
    expect(cache.load()).toEqual({ value: 42, savedAt: 900_000 })
    stop()
  })

  test('a cached value does not hold back the first read', async () => {
    const time = fakeClock()
    const cache = storageCache(() => memoryStorage(), 'k', 1, numberOnly)
    cache.save({ value: 41, savedAt: 0 })
    const source = counter()
    const stop = createSharedRead(source.read, { intervalMs: 60_000, clock: time.clock, cache }).subscribe(() => {})
    await settle()
    expect(source.calls()).toBe(1)
    stop()
  })

  test('a failed read keeps the cached value and saves nothing', async () => {
    const time = fakeClock()
    const storage = memoryStorage()
    const cache = storageCache(() => storage, 'k', 1, numberOnly)
    cache.save({ value: 41, savedAt: 0 })
    const store = createSharedRead(() => Promise.reject(new Error('offline')), { intervalMs: 60_000, clock: time.clock, cache })
    const stop = store.subscribe(() => {})
    await settle()
    expect(store.get()).toBe(41)
    expect(store.readAt()).toBe(0)
    expect(cache.load()).toEqual({ value: 41, savedAt: 0 })
    stop()
  })
})
