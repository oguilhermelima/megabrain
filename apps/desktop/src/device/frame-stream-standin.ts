import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { api } from '@/api'
import { frameDelay } from '@/device/screen-model'
import { onVisibility, windowShows } from '@/lib/app-events'
import { native } from '@/lib/surface'

// Stand-in for the stream lane's device/frame-stream.ts until it merges: the same useFrameStream
// shape, so the Device tab swaps the import and nothing else. A browser's stream is MJPEG over
// http, which an img plays on its own; a simulator's `standin-frame:<udid>` URL (from
// simulatorStream in native-input-standin, while `native input stream` is missing) is read the old
// way, a `native input frame` about every 250 ms while the window shows and has focus.

export interface FrameStream {
  src: string | null
  width: number
  height: number
  fps: number
  error: string | null
  stalled: boolean
}

const standinScheme = 'standin-frame:'

/** The pseudo stream URL that makes this stand-in poll a simulator's frames. */
export const standinStreamUrl = (udid: string) => `${standinScheme}${udid}`

/** The simulator a stand-in stream URL polls; null for a real stream. */
export function standinUdid(streamUrl: string): string | null {
  return streamUrl.startsWith(standinScheme) ? streamUrl.slice(standinScheme.length) || null : null
}

/** A frame no newer than this means the stream stalled. */
export const stallMs = 3_000

/** The wait before polling again after a failed frame: doubling from a second, at most ten. */
export const retryDelay = (failures: number) => Math.min(10_000, 1_000 * 2 ** Math.max(0, failures - 1))

/** A frame's image as an img src: a data URL as is, a file through the asset protocol, else base64 PNG. */
function frameSrc(image: string, version: number): string {
  if (image.startsWith('data:')) return image
  if (image.startsWith('/')) return native ? `${convertFileSrc(image)}?v=${version}` : image
  return `data:image/png;base64,${image}`
}

const idle: FrameStream = { src: null, width: 0, height: 0, fps: 0, error: null, stalled: false }

// The last frame each stream showed, so one shown again starts from it.
const lastFrames = new Map<string, FrameStream>()

/** The window's focus, with when it was lost, so a short glance elsewhere keeps the screen live. */
function useWindowFocus() {
  const [focus, setFocus] = useState(() => ({ focused: typeof document === 'undefined' || document.hasFocus(), blurredAt: null as number | null }))
  useEffect(() => {
    const onFocus = () => setFocus({ focused: true, blurredAt: null })
    const onBlur = () => setFocus({ focused: false, blurredAt: Date.now() })
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return focus
}

export function useFrameStream(streamUrl: string | null, opts?: { paused?: boolean }): FrameStream {
  const paused = opts?.paused === true
  const [stream, setStream] = useState<FrameStream>(() => (streamUrl === null ? idle : (lastFrames.get(streamUrl) ?? idle)))
  const [visible, setVisible] = useState(windowShows)
  const { focused, blurredAt } = useWindowFocus()
  useEffect(() => onVisibility(() => setVisible(windowShows())), [])

  useEffect(() => {
    setStream(streamUrl === null ? idle : (lastFrames.get(streamUrl) ?? idle))
  }, [streamUrl])

  useEffect(() => {
    if (streamUrl === null || paused || !visible) return
    const udid = standinUdid(streamUrl)
    let stopped = false
    let version = 0
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const shown: number[] = []
    const show = (next: Omit<FrameStream, 'fps' | 'stalled' | 'error'>) => {
      const now = Date.now()
      shown.push(now)
      while (shown.length > 0 && (shown[0] ?? now) < now - 1_000) shown.shift()
      const frame = { ...next, fps: shown.length, error: null, stalled: false }
      lastFrames.set(streamUrl, frame)
      setStream(frame)
    }
    const stall = setInterval(() => {
      const last = shown.at(-1)
      if (last !== undefined && Date.now() - last > stallMs) setStream((current) => (current.stalled ? current : { ...current, stalled: true, fps: 0 }))
    }, 1_000)

    if (udid === null) {
      // An MJPEG stream plays in the img itself; its size is known once the first frame decoded.
      const image = new Image()
      image.onload = () => !stopped && show({ src: streamUrl, width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => !stopped && setStream((current) => ({ ...current, error: 'The stream did not answer', stalled: true }))
      image.src = streamUrl
      return () => {
        stopped = true
        clearInterval(stall)
        image.src = ''
      }
    }

    const read = () => {
      if (stopped) return
      api
        .inputFrame(udid)
        .then(async (next) => {
          const src = frameSrc(next.image, (version += 1))
          const image = new Image()
          image.src = src
          await image.decode()
          if (stopped) return
          failures = 0
          show({ src, width: next.width || image.naturalWidth, height: next.height || image.naturalHeight })
          const delay = frameDelay({ visible, focused, blurredAt, now: Date.now(), booted: true })
          if (delay !== null) timer = setTimeout(read, delay)
        })
        .catch((failure: unknown) => {
          if (stopped) return
          failures += 1
          setStream((current) => ({ ...current, error: failure instanceof Error ? failure.message : String(failure), stalled: true, fps: 0 }))
          timer = setTimeout(read, retryDelay(failures))
        })
    }
    const delay = frameDelay({ visible, focused, blurredAt, now: Date.now(), booted: true })
    if (delay !== null) read()
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(stall)
    }
  }, [streamUrl, paused, visible, focused, blurredAt])

  return stream
}
