import { useEffect, useState } from 'react'
import { api } from '@/api'
import { createInputSessions, type InputView } from '@/device/input-session'
import { simulatorStream, type SimulatorStream } from '@/device/native-input-standin'

const inputSessions = createInputSessions({
  start: (udid) => api.inputStart(udid),
  status: (udid) => api.inputStatus(udid),
  stop: (udid) => api.inputStop(udid),
  now: Date.now,
  later: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
})

/** The shown device's input session (see input-session), watched while it is booted and free to take input. */
export function useInputSession(udid: string | null, wanted: boolean) {
  const [view, setView] = useState<InputView>({ kind: 'idle' })
  useEffect(() => {
    if (udid === null || !wanted) {
      setView({ kind: 'idle' })
      return
    }
    return inputSessions.watch(udid, setView)
  }, [udid, wanted])
  return {
    view,
    retry: () => {
      if (udid !== null) inputSessions.retry(udid)
    },
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A simulator's stream URL, size and scale, asked for once its input session is ready; `retry` asks again. */
export function useSimulatorStream(udid: string | null, ready: boolean) {
  const [stream, setStream] = useState<SimulatorStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setStream(null)
    setError(null)
    if (udid === null || !ready) return
    let current = true
    simulatorStream(udid).then(
      (next) => current && setStream(next),
      (failure: unknown) => current && setError(message(failure)),
    )
    return () => {
      current = false
    }
  }, [udid, ready, attempt])
  return { stream, error, retry: () => setAttempt((count) => count + 1) }
}
