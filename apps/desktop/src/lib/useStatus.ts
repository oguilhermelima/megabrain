import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Status } from '@/api/schema'
import { traySummary } from '@/lib/tray'

const visibleMs = 2_000
const hiddenMs = 15_000

/** Polls `megabrain status --json`: every `everyMs` while the window shows, every 15 s otherwise. */
export function useStatus(everyMs = visibleMs): { status: Status | null; error: unknown } {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const next = await api.status()
        if (stopped) return
        setStatus(next)
        setError(null)
        const summary = traySummary(next)
        await api.setTraySummary(summary.findings, summary.lines)
      } catch (caught) {
        if (!stopped) setError(caught)
      }
      if (stopped) return
      const visible = await api.windowVisible().catch(() => true)
      timer = setTimeout(tick, visible ? everyMs : hiddenMs)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [everyMs])

  return { status, error }
}
