import { useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { Status } from '@/api/schema'
import { statusPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { traySummary } from '@/lib/tray'
import { usePoll } from '@/lib/usePoll'

/** Polls `megabrain status --json`: every `visibleMs` while the window shows, every 30 s otherwise. */
export function useStatus(visibleMs = statusPolicy.visibleMs): { status: Status | null; error: unknown } {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<unknown>(null)
  const last = useRef<Status | null>(null)
  const policy = useMemo(() => ({ ...statusPolicy, visibleMs }), [visibleMs])

  usePoll(
    policy,
    async (current) => {
      try {
        const next = await api.status()
        if (!current()) return
        setError(null)
        // An unchanged answer keeps the same object: nothing renders and the tray is already right.
        const merged = reuse(last.current, next)
        if (merged === last.current) return
        last.current = merged
        setStatus(merged)
        const summary = traySummary(merged)
        await api.setTraySummary(summary.findings, summary.lines)
      } catch (caught) {
        if (current()) setError(caught)
      }
    },
    [],
  )

  return { status, error }
}
