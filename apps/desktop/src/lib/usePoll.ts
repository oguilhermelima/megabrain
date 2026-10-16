import { useEffect, useRef, type DependencyList } from 'react'
import { onAction, onFocus, onVisibility, windowShows } from '@/lib/app-events'
import { planPoll, pollInterval, type PollPolicy, type PollTrigger } from '@/lib/poll-model'

/**
 * Runs `read` on the policy's schedule (see poll-model.ts), one read at a time; a refresh asked for
 * during a read runs once it ends. `current()` turns false once the deps changed or the component
 * left, so a late answer is dropped.
 */
export function usePoll(policy: PollPolicy, read: (current: () => boolean) => Promise<void>, deps: DependencyList) {
  const latest = useRef(read)
  latest.current = read

  useEffect(() => {
    let stopped = false
    let running = false
    let pending = false
    let lastRunAt: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => !stopped

    const schedule = (ms: number | null) => {
      clearTimeout(timer)
      timer = ms === null ? undefined : setTimeout(() => trigger('timer'), ms)
    }

    const trigger = (kind: PollTrigger) => {
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
      latest.current(current)
        .catch(() => {})
        .finally(() => {
          running = false
          if (stopped) return
          if (pending) {
            pending = false
            trigger('start')
            return
          }
          schedule(pollInterval(policy, windowShows()))
        })
    }

    const stops = [onVisibility(() => trigger('visibility')), onFocus(() => trigger('focus')), onAction(() => trigger('action'))]
    trigger('start')
    return () => {
      stopped = true
      clearTimeout(timer)
      for (const stop of stops) stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, ...deps])
}
