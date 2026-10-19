import { describe, expect, test } from 'bun:test'
import { boardItemsPolicy, deviceCatalogPolicy, devicesPolicy, githubCountsPolicy, mapLimited, planPoll, projectsPolicy, quickViewPolicy, retryDelay, statusPolicy, type PollPolicy } from '@/lib/poll-model'

const policy: PollPolicy = { visibleMs: 30_000, hiddenMs: null, refreshOn: { action: true, focus: true } }
const hiddenToo: PollPolicy = { visibleMs: 5_000, hiddenMs: 30_000, refreshOn: { action: true, focus: true } }

describe('the policies', () => {
  test('status: every 5 s while visible, 30 s hidden, refreshed after an action and on focus', () => {
    expect(statusPolicy).toEqual({ visibleMs: 5_000, hiddenMs: 30_000, refreshOn: { action: true, focus: true } })
  })
  test('projects: every 30 s while visible, paused while hidden, refreshed after an action and on focus', () => {
    expect(projectsPolicy).toEqual({ visibleMs: 30_000, hiddenMs: null, refreshOn: { action: true, focus: true } })
  })
  test('quick view changes: every 10 s, only while visible', () => {
    expect(quickViewPolicy.visibleMs).toBe(10_000)
    expect(quickViewPolicy.hiddenMs).toBeNull()
  })
  test('github counts: every 120 s, paused while hidden, not refreshed by app actions', () => {
    expect(githubCountsPolicy).toEqual({ visibleMs: 120_000, hiddenMs: null, refreshOn: { action: false, focus: false } })
  })
})

describe('planPoll', () => {
  test('the first read runs at once, visible or not', () => {
    expect(planPoll(policy, 'start', { visible: true, now: 0, lastRunAt: null })).toEqual({ run: true, nextInMs: 30_000 })
    expect(planPoll(policy, 'start', { visible: false, now: 0, lastRunAt: null })).toEqual({ run: true, nextInMs: null })
    expect(planPoll(hiddenToo, 'start', { visible: false, now: 0, lastRunAt: null })).toEqual({ run: true, nextInMs: 30_000 })
  })

  test('a timer runs at the visible interval while the window shows', () => {
    expect(planPoll(policy, 'timer', { visible: true, now: 30_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 30_000 })
  })

  test('a timer uses the hidden interval while hidden', () => {
    expect(planPoll(hiddenToo, 'timer', { visible: false, now: 30_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 30_000 })
  })

  test('a hidden window with no hidden interval pauses: nothing runs, no timer', () => {
    expect(planPoll(policy, 'timer', { visible: false, now: 30_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: null })
    expect(planPoll(policy, 'visibility', { visible: false, now: 10_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: null })
  })

  test('a timer that fires early waits out the rest of the interval', () => {
    expect(planPoll(hiddenToo, 'timer', { visible: false, now: 10_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 20_000 })
  })

  test('showing the window runs at once when the read is overdue, else waits the rest', () => {
    expect(planPoll(policy, 'visibility', { visible: true, now: 45_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 30_000 })
    expect(planPoll(policy, 'visibility', { visible: true, now: 10_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 20_000 })
  })

  test('going hidden moves a running poll to the hidden interval', () => {
    expect(planPoll(hiddenToo, 'visibility', { visible: false, now: 4_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 26_000 })
  })

  test('an action in the app refreshes at once and restarts the interval', () => {
    expect(planPoll(policy, 'action', { visible: true, now: 1_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 30_000 })
  })

  test('focus refreshes at once', () => {
    expect(planPoll(policy, 'focus', { visible: true, now: 1_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 30_000 })
  })

  test('a policy that ignores actions and focus keeps its schedule', () => {
    expect(planPoll(githubCountsPolicy, 'action', { visible: true, now: 20_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 100_000 })
    expect(planPoll(githubCountsPolicy, 'focus', { visible: true, now: 20_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 100_000 })
  })

  test('an action while hidden and paused still refreshes, but sets no timer', () => {
    expect(planPoll(policy, 'action', { visible: false, now: 1_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: null })
  })
})

describe('mapLimited', () => {
  test('keeps the input order in its result', async () => {
    const result = await mapLimited([30, 10, 20], 2, (value) => new Promise<number>((resolve) => setTimeout(() => resolve(value * 2), value)))
    expect(result).toEqual([60, 20, 40])
  })

  test('never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
    })
    expect(peak).toBe(3)
  })

  test('an empty list resolves to an empty list', async () => {
    expect(await mapLimited([], 3, async () => 1)).toEqual([])
  })
})

describe('retryDelay', () => {
  test('backs off from 1 s, doubling, up to the interval', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((failures) => retryDelay(failures, 30_000))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  test('never waits longer than the interval, and pauses with it', () => {
    expect(retryDelay(1, 500)).toBe(500)
    expect(retryDelay(3, null)).toBeNull()
  })
})

describe('the Device tab inventory', () => {
  test('reads the simulator catalogs far less often than the booted list, and not while hidden', () => {
    expect(devicesPolicy.visibleMs).toBe(5_000)
    expect(deviceCatalogPolicy.visibleMs).toBeGreaterThanOrEqual(60_000)
    expect(deviceCatalogPolicy.hiddenMs).toBeNull()
    expect(planPoll(deviceCatalogPolicy, 'timer', { visible: true, now: 30_000, lastRunAt: 0 }).run).toBe(false)
  })
})

describe('the Tasks board items', () => {
  test('read again once a minute while the window shows, and never while it is hidden', () => {
    expect(boardItemsPolicy.visibleMs).toBe(60_000)
    expect(boardItemsPolicy.hiddenMs).toBeNull()
    expect(planPoll(boardItemsPolicy, 'timer', { visible: false, now: 600_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: null })
  })
})
