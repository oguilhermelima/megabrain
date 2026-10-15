import type { ProjectSession } from '@/api/schema'

export interface SessionTimer {
  text: string
  tone: 'neutral' | 'warn' | 'bad'
}

const minute = 60_000

function ahead(iso: string | null | undefined, now: number): number | null {
  if (iso === null || iso === undefined) return null
  const left = Date.parse(iso) - now
  return Number.isFinite(left) && left > 0 ? left : null
}

/**
 * The chip that says when an idle session loses its context: idle compaction first when it is still
 * ahead, else the prompt cache. Amber under ten minutes, red under two; null when neither is ahead.
 */
export function sessionTimer(session: Pick<ProjectSession, 'cacheExpiresAt' | 'idleCompactAt'>, now: number): SessionTimer | null {
  const compact = ahead(session.idleCompactAt, now)
  const cache = ahead(session.cacheExpiresAt, now)
  const left = compact ?? cache
  if (left === null) return null
  const minutes = Math.ceil(left / minute)
  const tone = left < 2 * minute ? 'bad' : left < 10 * minute ? 'warn' : 'neutral'
  return { text: compact === null ? `cache ${minutes}m` : `compacts in ${minutes}m`, tone }
}
