import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { parseOrder } from '@/advanced/project-order'
import { emptyLayout, parseLayout, serialiseLayout, type SidebarLayout } from '@/advanced/sidebar-folders'

// The sidebar's folders and top-level order. megabrain's settings hold them for good; this viewer's
// storage keeps a copy so the sidebar draws its folders before the CLI answers. A burst of changes
// (a drag, a rename) is written once, 300 ms after the last one.

const cacheKey = 'megabrain.sidebar.folders'
/** The flat project order the sidebar kept before folders; it seeds the layout once. */
const legacyOrderKey = 'megabrain.sidebar.order'
const writeDelay = 300

function cachedLayout(): SidebarLayout {
  try {
    const cached = localStorage.getItem(cacheKey)
    if (cached !== null) return parseLayout(JSON.parse(cached) as unknown)
    return { ...emptyLayout, order: parseOrder(localStorage.getItem(legacyOrderKey)) }
  } catch {
    return emptyLayout
  }
}

function cache(layout: SidebarLayout) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(layout))
  } catch {
    // The saved settings still hold it; the copy only saves a moment at start.
  }
}

const isEmpty = (layout: SidebarLayout) => layout.folders.length === 0 && layout.order.length === 0

export function useSidebarLayout(): { layout: SidebarLayout; change: (next: SidebarLayout) => void; error: unknown } {
  const [layout, setLayout] = useState<SidebarLayout>(cachedLayout)
  const [error, setError] = useState<unknown>(null)
  const pending = useRef<SidebarLayout | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touched = useRef(false)
  const shown = useRef(layout)
  shown.current = layout

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const next = pending.current
    pending.current = null
    if (next === null) return
    api.setSidebarFolders(serialiseLayout(next)).then(() => setError(null), setError)
  }, [])

  const change = useCallback(
    (next: SidebarLayout) => {
      touched.current = true
      setLayout(next)
      cache(next)
      pending.current = next
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(flush, writeDelay)
    },
    [flush],
  )

  // The saved layout wins over the copy, unless the person already changed something; with nothing
  // saved yet, the copy (or the order from before folders) becomes the saved one.
  useEffect(() => {
    let live = true
    api.sidebarFolders().then(
      (raw) => {
        if (!live || touched.current) return
        const saved = parseLayout(raw)
        if (!isEmpty(saved)) {
          setLayout(saved)
          cache(saved)
          return
        }
        if (isEmpty(shown.current)) return
        pending.current = shown.current
        flush()
      },
      (caught: unknown) => live && setError(caught),
    )
    return () => {
      live = false
    }
  }, [flush])

  // A write still waiting when the window goes is sent at once.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return { layout, change, error }
}
