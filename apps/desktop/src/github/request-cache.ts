type CachedValue = { expiresAt: number; value: unknown }

/** Shares active reads and reuses their results until the caller's next polling window. */
export function createRequestCache(now: () => number = Date.now) {
  const values = new Map<string, CachedValue>()
  const pending = new Map<string, Promise<unknown>>()

  return {
    request<T>(key: string, maxAgeMs: number, read: () => Promise<T>): Promise<T> {
      const time = now()
      for (const [staleKey, value] of values) {
        if (time >= value.expiresAt) values.delete(staleKey)
      }
      const cached = values.get(key)
      if (cached !== undefined) return Promise.resolve(cached.value as T)

      const active = pending.get(key)
      if (active !== undefined) return active as Promise<T>

      let result: Promise<T>
      try {
        result = Promise.resolve(read())
      } catch (error) {
        return Promise.reject(error)
      }
      let started: Promise<T>
      started = result.then(
        (value) => {
          if (pending.get(key) === started) values.set(key, { expiresAt: now() + maxAgeMs, value })
          return value
        },
      ).finally(() => {
        if (pending.get(key) === started) pending.delete(key)
      })
      pending.set(key, started)
      return started
    },
    invalidate(matches: (key: string) => boolean): void {
      for (const key of new Set([...values.keys(), ...pending.keys()])) {
        if (!matches(key)) continue
        values.delete(key)
        pending.delete(key)
      }
    },
  }
}
