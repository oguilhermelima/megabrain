// One live follow per key for the whole app, however many views read it: the first subscriber starts
// it, a later one gets the latest value at once, the last to leave stops it. While the window is
// hidden every follow pauses, and showing the window starts them again.

type Start<T> = (key: string, onValue: (value: T) => void, onEnd?: (error: string | null) => void) => Promise<() => void>

interface Subscriber<T> {
  onValue: (value: T) => void
  onEnd?: (error: string | null) => void
}

interface Entry<T> {
  subscribers: Set<Subscriber<T>>
  latest: T | undefined
  stop: (() => void) | null
  /** Settles once the follow started, or rejects when it could not. */
  starting: Promise<void> | null
}

export function createSharedFollow<T>({ start, visible, onVisibility }: { start: Start<T>; visible: () => boolean; onVisibility: (listener: () => void) => () => void }) {
  const entries = new Map<string, Entry<T>>()
  let unwatch: (() => void) | null = null

  const run = (key: string, entry: Entry<T>): Promise<void> => {
    if (entry.starting !== null) return entry.starting
    if (!visible()) return Promise.resolve()
    const starting = start(
      key,
      (value) => {
        entry.latest = value
        for (const subscriber of entry.subscribers) subscriber.onValue(value)
      },
      (error) => {
        for (const subscriber of entry.subscribers) subscriber.onEnd?.(error)
      },
    ).then(
      (stop) => {
        // Everyone left, or the window hid, while it started.
        if (entries.get(key) !== entry || entry.starting !== starting) stop()
        else entry.stop = stop
      },
      (caught: unknown) => {
        if (entry.starting === starting) entry.starting = null
        throw caught
      },
    )
    entry.starting = starting
    return starting
  }

  const pause = (entry: Entry<T>) => {
    entry.stop?.()
    entry.stop = null
    entry.starting = null
  }

  const onShow = () => {
    for (const [key, entry] of entries) {
      if (visible()) void run(key, entry).catch(() => {})
      else pause(entry)
    }
  }

  return async function follow(key: string, onValue: (value: T) => void, onEnd?: (error: string | null) => void): Promise<() => void> {
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { subscribers: new Set(), latest: undefined, stop: null, starting: null }
      entries.set(key, entry)
    }
    const own = entry
    const subscriber: Subscriber<T> = onEnd === undefined ? { onValue } : { onValue, onEnd }
    own.subscribers.add(subscriber)
    unwatch ??= onVisibility(onShow)
    const leave = () => {
      if (!own.subscribers.delete(subscriber) || own.subscribers.size > 0) return
      pause(own)
      entries.delete(key)
      if (entries.size === 0) {
        unwatch?.()
        unwatch = null
      }
    }
    if (own.latest !== undefined) onValue(own.latest)
    try {
      await run(key, own)
    } catch (caught) {
      leave()
      throw caught
    }
    return leave
  }
}
