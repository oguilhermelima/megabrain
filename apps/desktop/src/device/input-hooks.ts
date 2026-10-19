import { useEffect, useState } from 'react'
import { api } from '@/api'
import { createInputSessions, type InputView } from '@/device/input-session'
import type { InputStream, InputFrame } from '@/api/schema'

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
  const [stream, setStream] = useState<InputStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallback, setFallback] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setStream(null)
    setError(null)
    setFallback(false)
    if (udid === null || !ready) return
    let current = true
    api.inputStream(udid).then(
      (next) => current && setStream(next),
      (failure: unknown) => {
        if (!current) return
        setError(message(failure))
        setFallback(true)
      },
    )
    return () => {
      current = false
    }
  }, [udid, ready, attempt])
  return { stream, error, fallback, retry: () => setAttempt((count) => count + 1) }
}

type FallbackFrame = { src: string | null; width: number; height: number; scale: number; error: string | null; stalled: boolean }
const emptyFrame: FallbackFrame = { src: null, width: 0, height: 0, scale: 1, error: null, stalled: false }

function imageSource(frame: InputFrame): string {
  if (frame.image.startsWith('data:')) return frame.image
  if (frame.image.startsWith('/')) return frame.image
  return `data:image/png;base64,${frame.image}`
}

/** Polls a still frame only after `native input stream` fails; the screen labels this fallback. */
export function useSimulatorFallbackFrame(udid: string | null, enabled: boolean): FallbackFrame {
  const [frame, setFrame] = useState<FallbackFrame>(emptyFrame)
  useEffect(() => {
    setFrame(emptyFrame)
    if (udid === null || !enabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const next = await api.inputFrame(udid)
        if (stopped) return
        setFrame({ src: imageSource(next), width: next.width, height: next.height, scale: next.scale, error: null, stalled: false })
      } catch (failure: unknown) {
        if (stopped) return
        setFrame((current) => ({ ...current, error: message(failure), stalled: true }))
      }
      if (!stopped) timer = setTimeout(read, 250)
    }
    void read()
    return () => { stopped = true; clearTimeout(timer) }
  }, [udid, enabled])
  return frame
}
