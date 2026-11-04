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
// The Device tab's simulators: a device shut down anywhere (simctl, another app) leaves within 5 s.
export const devicesPolicy: PollPolicy = { visibleMs: 5_000, hiddenMs: null, refreshOn: { action: true, focus: true } }
// The simulators that can be booted: the catalog changes only when a runtime or device type is added.
export const deviceCatalogPolicy: PollPolicy = { visibleMs: 120_000, hiddenMs: null, refreshOn: { action: false, focus: false } }
// The action bar's Diff badge: git status and a merge-base diff, both native and cheap.
export const changesPolicy: PollPolicy = { visibleMs: 10_000, hiddenMs: null, refreshOn: { action: true, focus: true } }
export const quickViewPolicy: PollPolicy = { visibleMs: 10_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
// A simulator screenshot while a Maestro run goes on: one simctl capture, the screen's refresh rate in the Device tab.
export const screenPolicy: PollPolicy = { visibleMs: 2_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
// The Tasks board's items: one GitHub page a read, once a minute and only while the window shows.
export const boardItemsPolicy: PollPolicy = { visibleMs: 60_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
// The Tasks page's list of a repository's GitHub Projects: rarely changes, so every five minutes and on focus.
export const boardListPolicy: PollPolicy = { visibleMs: 300_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
// The GitHub listing's shown page: once a minute while the window shows, at once when it shows again.
export const githubListingPolicy: PollPolicy = { visibleMs: 60_000, hiddenMs: null, refreshOn: { action: false, focus: false } }
// The CLI caches each GitHub answer for 60 s; the badges can wait twice that.
export const githubCountsPolicy: PollPolicy = { visibleMs: 120_000, hiddenMs: null, refreshOn: { action: false, focus: false } }
// Workflow runs: every 10 s while one shown is queued or running, else once a minute; paused while hidden.
export const actionsLivePolicy: PollPolicy = { visibleMs: 10_000, hiddenMs: null, refreshOn: { action: false, focus: true } }
export const actionsPolicy: PollPolicy = { visibleMs: 60_000, hiddenMs: null, refreshOn: { action: false, focus: true } }

/** How long to wait after `failures` failed reads in a row: 1 s, doubling, never past the interval. */
export function retryDelay(failures: number, interval: number | null): number | null {
  if (interval === null) return null
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), interval)
}

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
