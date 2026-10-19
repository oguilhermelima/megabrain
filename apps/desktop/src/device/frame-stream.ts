import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type FrameUpdate = { src: string | null; width: number; height: number; fps: number; error: string | null; stalled: boolean }
export type FrameStreamSource = { subscribe(url: string, onUpdate: (update: FrameUpdate) => void): () => void }

const empty: FrameUpdate = { src: null, width: 0, height: 0, fps: 0, error: null, stalled: false }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const tauriSource: FrameStreamSource = {
  subscribe(url, onUpdate) {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let nativeSubscribed = false
    void listen<FrameUpdate & { url: string }>('device-frame', ({ payload }) => {
      if (payload.url === url) onUpdate(payload)
    }).then((stopListening) => {
      unlisten = stopListening
      if (cancelled) { stopListening(); return }
      void invoke<{ key: string; src: string | null; width: number; height: number }>('frame_stream_subscribe', { url }).then(({ src, width, height }) => {
        nativeSubscribed = true
        if (cancelled) void invoke('frame_stream_unsubscribe', { url })
        else if (src) onUpdate({ ...empty, src, width, height })
      }).catch((error: unknown) => onUpdate({ ...empty, error: errorMessage(error), stalled: true }))
    }).catch((error: unknown) => onUpdate({ ...empty, error: errorMessage(error), stalled: true }))
    return () => {
      cancelled = true
      unlisten?.()
      if (nativeSubscribed) void invoke('frame_stream_unsubscribe', { url })
    }
  },
}

/** Shares one native reader per URL among every mounted consumer. */
export function createFrameStreamClient(source: FrameStreamSource) {
  const entries = new Map<string, { stop: () => void; watchers: Set<(update: FrameUpdate) => void>; current: FrameUpdate; times: number[]; stallTimer: ReturnType<typeof setTimeout> | null }>()
  return {
    watch(url: string, watcher: (update: FrameUpdate) => void) {
      let entry = entries.get(url)
      if (!entry) {
        entry = { stop: () => {}, watchers: new Set(), current: empty, times: [], stallTimer: null }
        entries.set(url, entry)
        const held = entry
        held.stop = source.subscribe(url, (update) => {
          if (entries.get(url) !== held) return
          if (update.src) {
            const now = Date.now()
            held.times = held.times.filter((time) => now - time < 1000)
            held.times.push(now)
            update = { ...update, fps: held.times.length }
          }
          held.current = update
          for (const subscriber of held.watchers) subscriber(update)
          if (held.stallTimer) clearTimeout(held.stallTimer)
          held.stallTimer = update.src ? setTimeout(() => {
            if (entries.get(url) !== held || !held.current.src) return
            held.current = { ...held.current, fps: 0, stalled: true }
            for (const subscriber of held.watchers) subscriber(held.current)
          }, 1500) : null
        })
      }
      const held = entry
      held.watchers.add(watcher)
      if (held.current !== empty) watcher(held.current)
      return () => {
        held.watchers.delete(watcher)
        if (held.watchers.size) return
        held.stop()
        if (held.stallTimer) clearTimeout(held.stallTimer)
        entries.delete(url)
      }
    },
  }
}

const client = createFrameStreamClient(tauriSource)

/** Follows one persistent loopback MJPEG stream; it pauses while hidden and releases it when unused. */
export function useFrameStream(streamUrl: string | null, opts: { paused?: boolean } = {}): FrameUpdate {
  const [frame, setFrame] = useState<FrameUpdate>(empty)
  const paused = opts.paused ?? false
  useEffect(() => {
    if (!streamUrl || paused) { setFrame(empty); return }
    const url = streamUrl
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    let visible = document.visibilityState === 'visible'
    const stop = visible ? client.watch(url, setFrame) : undefined
    function setVisible(isVisible: boolean) {
      if (visible === isVisible) return
      visible = isVisible
      if (visible) {
        cleanup = client.watch(url, setFrame)
      } else {
        cleanup?.()
        cleanup = undefined
        setFrame(empty)
      }
    }
    let cleanup = stop
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); cleanup?.() }
  }, [streamUrl, paused])
  return frame
}
