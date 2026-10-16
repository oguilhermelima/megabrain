// One background read shared by every component that shows its result: it runs at most once per
// interval while the window shows and anyone listens, never twice at once, and pauses while hidden.
// A failed read keeps the last value. With a cache, the last good value shows from the first paint
// while the first read runs behind it.

export interface SharedReadClock {
  now(): number
  visible(): boolean
  /** Runs `run` after `ms`; the returned function cancels it. */
  setTimer(run: () => void, ms: number): () => void
}

/** A value and when it was read. */
export interface Cached<T> {
  value: T
  savedAt: number
}

export interface SharedReadCache<T> {
  load(): Cached<T> | null
  save(entry: Cached<T>): void
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * A cache in key-value storage under a versioned key. A missing, corrupt or misshapen entry, and
 * storage that throws or is absent, all read as nothing; a save that fails is dropped.
 */
export function storageCache<T>(storage: () => KeyValueStorage | null, key: string, version: number, parse: (raw: unknown) => T | null): SharedReadCache<T> {
  const versionedKey = `${key}.v${version}`
  return {
    load() {
      try {
        const text = storage()?.getItem(versionedKey)
        if (text === null || text === undefined) return null
        const raw: unknown = JSON.parse(text)
        if (typeof raw !== 'object' || raw === null || !('savedAt' in raw) || !('value' in raw)) return null
        if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) return null
        const value = parse(raw.value)
        return value === null ? null : { value, savedAt: raw.savedAt }
      } catch {
        return null
      }
    },
    save(entry) {
      try {
        storage()?.setItem(versionedKey, JSON.stringify(entry))
      } catch {
        // Full or denied storage only costs the next first paint.
      }
    },
  }
}

export const staleAfterMs = 10 * 60_000

/** True once a value is older than `maxAgeMs`; a value never read is not stale. */
export function isStale(savedAt: number | null, now: number, maxAgeMs: number = staleAfterMs): boolean {
  return savedAt !== null && now - savedAt > maxAgeMs
}

export interface SharedRead<T> {
  /** The last value read, else the cached one, or null before either. */
  get(): T | null
  /** When the value `get` returns was read, or null without one. */
  readAt(): number | null
  /** Listens for new values and starts reading if the last read is stale; returns the unsubscribe. */
  subscribe(listener: (value: T) => void): () => void
  /** Reads now unless a read ran within the interval or is running. */
  refresh(): void
  /** True while the last read failed; the value `get` returns is then the one from before. */
  failed(): boolean
  /** Listens for any change a view shows: a new value, or a read failing or recovering. */
  onChange(listener: () => void): () => void
  /** Call when the window shows or hides: hidden stops the timer, shown reads if the last read is stale. */
  visibilityChanged(): void
}

export function createSharedRead<T>(
  read: () => Promise<T>,
  { intervalMs, retryMs = intervalMs, clock, cache }: { intervalMs: number; retryMs?: number; clock: SharedReadClock; cache?: SharedReadCache<T> },
): SharedRead<T> {
  // A cached value shows at once but does not count as a read, so the first listener still reads.
  const cached = cache?.load() ?? null
  let value: T | null = cached?.value ?? null
  let valueAt: number | null = cached?.savedAt ?? null
  let lastRunAt: number | null = null
  let running = false
  let failedLast = false
  const changes = new Set<() => void>()
  const changed = () => {
    for (const listener of changes) listener()
  }
  let cancel: (() => void) | null = null
  const listeners = new Set<(value: T) => void>()

  const stopTimer = () => {
    cancel?.()
    cancel = null
  }
  const elapsed = () => (lastRunAt === null ? Infinity : clock.now() - lastRunAt)
  // After a failure the next read comes sooner, so a blip does not leave the row empty for a minute.
  const gap = () => (failedLast ? retryMs : intervalMs)
  const active = () => listeners.size > 0 && clock.visible()

  const schedule = () => {
    stopTimer()
    if (!active() || running) return
    cancel = clock.setTimer(tick, Math.max(0, gap() - elapsed()))
  }

  function tick() {
    cancel = null
    if (!active() || running) return
    if (elapsed() < gap()) {
      schedule()
      return
    }
    running = true
    const startedAt = clock.now()
    lastRunAt = startedAt
    read()
      .then(
        (next) => {
          value = next
          valueAt = startedAt
          cache?.save({ value: next, savedAt: startedAt })
          failedLast = false
          for (const listener of listeners) listener(next)
          changed()
        },
        () => {
          failedLast = true
          changed()
        },
      )
      .finally(() => {
        running = false
        schedule()
      })
  }

  return {
    get: () => value,
    readAt: () => valueAt,
    subscribe(listener) {
      listeners.add(listener)
      tick()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopTimer()
      }
    },
    failed: () => failedLast,
    onChange(listener) {
      changes.add(listener)
      return () => changes.delete(listener)
    },
    refresh: tick,
    visibilityChanged() {
      if (clock.visible()) tick()
      else stopTimer()
    },
  }
}
