import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

// Rows that change place (a drop, ⌥↑ ⌥↓, a project moved into a folder) slide from where they were
// to where they land instead of jumping: capture() records each row's position just before the
// change, and the next commit plays the difference back over 180 ms. Reduced motion skips it.

const rowSelector = '[data-entry-key], [data-row-key]'
const keyOf = (element: HTMLElement) => element.dataset.entryKey ?? element.dataset.rowKey ?? ''

export function useFlip(root: RefObject<HTMLElement | null>): () => void {
  const before = useRef<Map<string, number> | null>(null)

  const capture = useCallback(() => {
    const element = root.current
    if (element === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    before.current = new Map([...element.querySelectorAll<HTMLElement>(rowSelector)].map((row) => [keyOf(row), row.getBoundingClientRect().top]))
  }, [root])

  useLayoutEffect(() => {
    const previous = before.current
    const element = root.current
    if (previous === null || element === null) return
    before.current = null
    const moved = new Set<HTMLElement>()
    for (const row of element.querySelectorAll<HTMLElement>(rowSelector)) {
      const top = previous.get(keyOf(row))
      // A row inside one that already slides moves with it.
      const parent = row.parentElement?.closest<HTMLElement>(rowSelector) ?? null
      if (parent !== null && moved.has(parent)) continue
      if (top === undefined) {
        row.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' })
        moved.add(row)
        continue
      }
      const delta = top - row.getBoundingClientRect().top
      if (Math.abs(delta) < 1) continue
      row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' })
      moved.add(row)
    }
  })

  return capture
}
