import { useCallback, useEffect, useRef, useState } from 'react'

// A sidebar setting megabrain's settings hold for good, with a copy in this viewer's storage so the
// sidebar can draw it before the CLI answers. The saved value wins over the copy unless the person
// already changed something; with nothing saved yet, the copy (or what `seed` finds from before)
// becomes the saved one. A burst of changes (a drag, a rename) is written once, 300 ms after the last
// one, and a write still waiting when the window goes is sent at once.

const writeDelay = 300

export interface SavedSetting<T> {
  /** This viewer's copy. */
  cacheKey: string
  /** The value when there is no copy: what the viewer kept before the CLI held it, or empty. */
  seed: () => T
  parse: (raw: unknown) => T
  serialise: (value: T) => string
  isEmpty: (value: T) => boolean
  read: () => Promise<unknown>
  write: (json: string) => Promise<void>
}

export function useSavedSetting<T>(setting: SavedSetting<T>): { value: T; change: (next: T) => void; error: unknown; ready: boolean } {
  const options = useRef(setting).current
  const [value, setValue] = useState<T>(() => {
    try {
      const cached = localStorage.getItem(options.cacheKey)
      return cached === null ? options.seed() : options.parse(JSON.parse(cached) as unknown)
    } catch {
      return options.seed()
    }
  })
  const [error, setError] = useState<unknown>(null)
  // True once the CLI answered, or failed to: until then the copy may not be what is saved.
  const [ready, setReady] = useState(false)
  const pending = useRef<T | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touched = useRef(false)
  const shown = useRef(value)
  shown.current = value

  const cache = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(options.cacheKey, options.serialise(next))
      } catch {
        // The saved settings still hold it; the copy only saves a moment at start.
      }
    },
    [options],
  )

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    pending.current = null
    if (next === null) return
    options.write(options.serialise(next)).then(() => setError(null), setError)
  }, [options])

  const change = useCallback(
    (next: T) => {
      touched.current = true
      setValue(next)
      cache(next)
      pending.current = next
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, writeDelay)
    },
    [cache, flush],
  )

  useEffect(() => {
    let live = true
    options.read().then(
      (raw) => {
        if (!live) return
        setReady(true)
        if (touched.current) return
        const saved = options.parse(raw)
        if (!options.isEmpty(saved)) {
          setValue(saved)
          cache(saved)
          return
        }
        if (options.isEmpty(shown.current)) return
        pending.current = shown.current
        flush()
      },
      (caught: unknown) => {
        if (!live) return
        setReady(true)
        setError(caught)
      },
    )
    return () => {
      live = false
    }
  }, [options, cache, flush])

  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return { value, change, error, ready }
}
