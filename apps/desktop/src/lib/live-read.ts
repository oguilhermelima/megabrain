import { createSharedRead, type SharedRead, type SharedReadCache, type SharedReadClock } from '@/lib/shared-read'

// A shared read that runs for the whole app, not for whoever is on screen: `start` holds it open
// from app start, so a pane that mounts later finds the value already there (or the last known
// one from the cache) instead of beginning the first read itself.

export interface LiveRead<T> extends SharedRead<T> {
  /** Keeps the read running, about every minute while the window shows; returns the stop. */
  start(): () => void
  /** The window took focus: reads if the last read is older than the interval. */
  focused(): void
}

export function createLiveRead<T>(
  read: () => Promise<T>,
  { clock, cache, intervalMs = 60_000, retryMs = 10_000 }: { clock: SharedReadClock; cache?: SharedReadCache<T>; intervalMs?: number; retryMs?: number },
): LiveRead<T> {
  const shared = createSharedRead(read, { intervalMs, retryMs, clock, cache })
  return {
    ...shared,
    start: () => shared.subscribe(() => {}),
    focused: shared.refresh,
  }
}
