// When each background read runs. Every read the app repeats is a CLI process, so it runs only as
// often as the window can show its result: slower or paused while hidden, at once after something
// the person did that changes it, and on focus.

export interface PollPolicy {
  visibleMs: number
  /** The interval while the window is hidden; null pauses the read until the window shows again. */
  hiddenMs: number | null
  /** Reads again at once after an action in the app (import, hide, remove, send) and on window focus. */
  refreshOn: { action: boolean; focus: boolean }
}

export const statusPolicy: PollPolicy = { visibleMs: 5_000, hiddenMs: 30_000, refreshOn: { action: true, focus: true } }
export const projectsPolicy: PollPolicy = { visibleMs: 30_000, hiddenMs: null, refreshOn: { action: true, focus: true } }
export const quickViewPolicy: PollPolicy = { visibleMs: 10_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
// The CLI caches each GitHub answer for 60 s; the badges can wait twice that.
export const githubCountsPolicy: PollPolicy = { visibleMs: 120_000, hiddenMs: null, refreshOn: { action: false, focus: false } }

export type PollTrigger = 'start' | 'timer' | 'action' | 'focus' | 'visibility'

export interface PollPlan {
  run: boolean
  /** When to look again: after the read when it runs, else from now; null sets no timer. */
  nextInMs: number | null
}

export function pollInterval(policy: PollPolicy, visible: boolean): number | null {
  return visible ? policy.visibleMs : policy.hiddenMs
}

export function planPoll(policy: PollPolicy, trigger: PollTrigger, at: { visible: boolean; now: number; lastRunAt: number | null }): PollPlan {
  const interval = pollInterval(policy, at.visible)
  const forced = trigger === 'start' || (trigger === 'action' && policy.refreshOn.action) || (trigger === 'focus' && policy.refreshOn.focus)
  if (forced) return { run: true, nextInMs: interval }
  if (interval === null) return { run: false, nextInMs: null }
  const elapsed = at.lastRunAt === null ? Infinity : at.now - at.lastRunAt
  if (elapsed >= interval) return { run: true, nextInMs: interval }
  return { run: false, nextInMs: interval - elapsed }
}

/** Maps every item with at most `limit` calls in flight, keeping the input order in the result. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
