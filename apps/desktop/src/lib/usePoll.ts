import { useCallback, useEffect, useRef, type DependencyList } from 'react'
import { onAction, onFocus, onVisibility, windowShows } from '@/lib/app-events'
import { planPoll, pollInterval, retryDelay, type PollPolicy, type PollTrigger } from '@/lib/poll-model'

/**
 * Runs `read` on the policy's schedule (see poll-model.ts), one read at a time; a refresh asked for
 * during a read runs once it ends. `current()` turns false once the deps changed or the component
 * left, so a late answer is dropped. A read that throws is tried again sooner (see retryDelay).
 * Returns a function that reads again now.
 */
export function usePoll(policy: PollPolicy, read: (current: () => boolean, refresh?: boolean) => Promise<void>, deps: DependencyList): () => void {
  const latest = useRef(read)
  latest.current = read
  const now = useRef<() => void>(() => {})

  useEffect(() => {
    let stopped = false
    let running = false
    let pending = false
    let lastRunAt: number | null = null
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => !stopped

    // A retry after a failed read is forced: the timer's own plan would wait out the full interval.
    const schedule = (ms: number | null, kind: PollTrigger = 'timer') => {
      clearTimeout(timer)
      timer = ms === null ? undefined : setTimeout(() => trigger(kind), ms)
    }

    const trigger = (kind: PollTrigger, refresh = false) => {
      if (stopped) return
      const plan = planPoll(policy, kind, { visible: windowShows(), now: Date.now(), lastRunAt })
      if (!plan.run) {
        if (!running) schedule(plan.nextInMs)
        return
      }
      if (running) {
        pending = true
        return
      }
      running = true
      clearTimeout(timer)
      lastRunAt = Date.now()
      latest.current(current, refresh)
        .then(
          () => {
            failures = 0
          },
          () => {
            failures += 1
          },
        )
        .finally(() => {
          running = false
          if (stopped) return
          if (pending) {
            pending = false
            trigger('start')
            return
          }
          const interval = pollInterval(policy, windowShows())
          if (failures === 0) schedule(interval)
          else schedule(retryDelay(failures, interval), 'start')
        })
    }

    const stops = [onVisibility(() => trigger('visibility')), onFocus(() => trigger('focus')), onAction(() => trigger('action'))]
    now.current = () => trigger('start', true)
    trigger('start')
    return () => {
      stopped = true
      clearTimeout(timer)
      for (const stop of stops) stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, ...deps])

  return useCallback(() => now.current(), [])
}
