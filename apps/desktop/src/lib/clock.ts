import { useEffect, useState } from 'react'
import { onVisibility, windowShows } from '@/lib/app-events'

// The clocks the app draws from (elapsed times, ages, timers): they tick only while the window shows,
// since nobody sees a hidden one, and catch up at once when it shows again.

/** How often a display clock ticks: its interval while the window shows, never while hidden. */
export const clockInterval = (visible: boolean, intervalMs: number): number | null => (visible ? intervalMs : null)

/** The current time, moved forward every interval while the window shows. */
export function useClock(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      clearInterval(timer)
      timer = undefined
      const interval = clockInterval(windowShows(), intervalMs)
      if (interval === null) return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), interval)
    }
    start()
    const stop = onVisibility(start)
    return () => {
      clearInterval(timer)
      stop()
    }
  }, [intervalMs])
  return now
}
