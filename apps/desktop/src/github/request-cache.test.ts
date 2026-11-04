import { describe, expect, test } from 'bun:test'
import { createRequestCache } from '@/github/request-cache'
import { githubListingPolicy } from '@/lib/poll-model'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('GitHub request cache', () => {
  test('shares an in-flight exact query and preserves its visible result', async () => {
    const cache = createRequestCache(() => 100)
    const pending = deferred<{ counts: { open: number }; items: string[] }>()
    let calls = 0
    const read = () => {
      calls += 1
      return pending.promise
    }

    const overview = cache.request('prs:/repo:open:30:null:{}', 60_000, read)
    const githubPage = cache.request('prs:/repo:open:30:null:{}', 60_000, read)
    const counts = cache.request('prs:/repo:open:30:null:{}', 60_000, read)
    expect(calls).toBe(1)
    pending.resolve({ counts: { open: 4 }, items: ['same visible row'] })
    const results = await Promise.all([overview, githubPage, counts])
    const visibleResult = { counts: { open: 4 }, items: ['same visible row'] }
    expect(results).toEqual([visibleResult, visibleResult, visibleResult])
  })

  test('keeps fulfilled values only for their freshness window and separates exact queries', async () => {
    let now = 100
    const cache = createRequestCache(() => now)
    let calls = 0
    const read = async () => ({ value: ++calls })

    expect(await cache.request('prs:/repo:open:30:null:{}', 60, read)).toEqual({ value: 1 })
    expect(await cache.request('prs:/repo:open:30:null:{}', 60, read)).toEqual({ value: 1 })
    expect(await cache.request('prs:/repo:merged:30:null:{}', 60, read)).toEqual({ value: 2 })
    now = 160
    expect(await cache.request('prs:/repo:open:30:null:{}', 60, read)).toEqual({ value: 3 })
    expect(calls).toBe(3)
  })

  test('a poll at the visible GitHub listing interval starts a fresh read', async () => {
    let now = 100
    const cache = createRequestCache(() => now)
    let calls = 0
    const read = async () => ++calls

    expect(await cache.request('list', 5_000, read)).toBe(1)
    now += githubListingPolicy.visibleMs
    expect(await cache.request('list', 5_000, read)).toBe(2)
  })

  test('a manual refresh bypasses a completed result in its short reuse window', async () => {
    let now = 100
    const cache = createRequestCache(() => now)
    let calls = 0
    const read = async () => ++calls

    expect(await cache.request('list', 5_000, read)).toBe(1)
    expect(await cache.request('list', 5_000, read, { refresh: true })).toBe(2)
  })

  test('simultaneous surfaces share one read even when one asks to refresh', async () => {
    const cache = createRequestCache(() => 100)
    const pending = deferred<number>()
    let calls = 0
    const read = () => {
      calls += 1
      return pending.promise
    }

    const page = cache.request('list', 5_000, read)
    const project = cache.request('list', 5_000, read, { refresh: true })
    const counts = cache.request('list', 5_000, read)
    expect(calls).toBe(1)
    pending.resolve(42)
    expect(await Promise.all([page, project, counts])).toEqual([42, 42, 42])
  })

  test('does not cache a failed read', async () => {
    const cache = createRequestCache(() => 100)
    let calls = 0
    await expect(cache.request('pr:/repo:42', 60_000, async () => {
      calls += 1
      throw new Error('temporary failure')
    })).rejects.toThrow('temporary failure')
    expect(await cache.request('pr:/repo:42', 60_000, async () => {
      calls += 1
      return 'recovered'
    })).toBe('recovered')
    expect(calls).toBe(2)
  })
})
