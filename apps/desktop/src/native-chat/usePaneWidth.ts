import { useCallback, useState } from 'react'

/** The width of the element `ref` lands on, followed as it resizes; Infinity until it is measured. */
export function usePaneWidth(): { ref: (element: HTMLElement | null) => void; width: number } {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}
