import { describe, expect, test } from 'bun:test'
import { sessionTimer } from '@/chat/header-model'

const now = Date.parse('2026-10-15T12:00:00Z')
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

describe('sessionTimer', () => {
  test('idle compaction comes first when it is still ahead', () => {
    expect(sessionTimer({ cacheExpiresAt: inMinutes(19), idleCompactAt: inMinutes(13) }, now)).toEqual({ text: 'compacts in 13m', tone: 'neutral' })
  })

  test('the cache expiry shows when compaction is past or unknown', () => {
    expect(sessionTimer({ cacheExpiresAt: inMinutes(19), idleCompactAt: inMinutes(-1) }, now)).toEqual({ text: 'cache 19m', tone: 'neutral' })
    expect(sessionTimer({ cacheExpiresAt: inMinutes(19), idleCompactAt: null }, now)).toEqual({ text: 'cache 19m', tone: 'neutral' })
    expect(sessionTimer({ cacheExpiresAt: inMinutes(19) }, now)).toEqual({ text: 'cache 19m', tone: 'neutral' })
  })

  test('amber under 10 minutes, red under 2', () => {
    expect(sessionTimer({ cacheExpiresAt: inMinutes(9.5) }, now)?.tone).toBe('warn')
    expect(sessionTimer({ cacheExpiresAt: inMinutes(10) }, now)?.tone).toBe('neutral')
    expect(sessionTimer({ cacheExpiresAt: inMinutes(1.5) }, now)?.tone).toBe('bad')
    expect(sessionTimer({ cacheExpiresAt: inMinutes(2) }, now)?.tone).toBe('warn')
  })

  test('under a minute still reads as a minute', () => {
    expect(sessionTimer({ idleCompactAt: inMinutes(0.2) }, now)).toEqual({ text: 'compacts in 1m', tone: 'bad' })
  })

  test('nothing ahead means no chip', () => {
    expect(sessionTimer({ cacheExpiresAt: inMinutes(-5), idleCompactAt: inMinutes(-1) }, now)).toBeNull()
    expect(sessionTimer({}, now)).toBeNull()
  })
})
