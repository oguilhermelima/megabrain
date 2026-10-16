import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CodeFrame, type CodeGoto } from '@/code/CodeFrame'
import type { CodeTarget } from '@/code/code-pane-model'
import type { CodeSlots } from '@/code/code-slots'
import { useStableCallback } from '@/lib/useStableCallback'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const sameBox = (left: Box | undefined, right: Box | undefined) =>
  left === right || (left !== undefined && right !== undefined && left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height)

/**
 * Every running root's VS Code, kept mounted in one layer over the panes and laid over the slot of
 * the pane that holds it (see frameHolders), so moving, splitting or resizing panes never reloads
 * a workbench. A root no pane shows stays mounted and hidden until its server stops. During a pane
 * drag the frames let the pointer through, so the drop target is found under them.
 */
export function CodeLayer({
  targets,
  holders,
  slots,
  gotos,
  dragging,
  onFocus,
}: {
  targets: readonly CodeTarget[]
  holders: Readonly<Record<string, string>>
  slots: CodeSlots
  gotos: Readonly<Record<string, CodeGoto>>
  dragging: boolean
  /** The keyboard went into a root's VS Code: its pane takes the focus. */
  onFocus: (root: string) => void
}) {
  const layer = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<Readonly<Record<string, Box>>>({})

  const measure = useStableCallback(() => {
    const origin = layer.current?.getBoundingClientRect()
    if (origin === undefined) return
    const next: Record<string, Box> = {}
    for (const target of targets) {
      const holder = holders[target.root]
      const rect = holder === undefined ? undefined : slots.get(holder)?.getBoundingClientRect()
      if (rect !== undefined) next[target.root] = { left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height }
    }
    setBoxes((previous) => {
      const roots = Object.keys(next)
      return roots.length === Object.keys(previous).length && roots.every((root) => sameBox(previous[root], next[root])) ? previous : next
    })
  })

  // A render can move a slot without resizing it (panes swapped), so every render measures again.
  useLayoutEffect(() => measure())

  useEffect(() => {
    const observer = new ResizeObserver(() => measure())
    const observe = () => {
      observer.disconnect()
      if (layer.current !== null) observer.observe(layer.current)
      for (const element of slots.elements()) observer.observe(element)
      measure()
    }
    observe()
    const unsubscribe = slots.subscribe(observe)
    // A pane rising into view moves its slot by a transform, which resizes nothing.
    const settle = () => measure()
    document.addEventListener('animationend', settle, true)
    return () => {
      unsubscribe()
      observer.disconnect()
      document.removeEventListener('animationend', settle, true)
    }
  }, [slots])

  // A click into a frame focuses it without any event reaching this document but the window's blur.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const active = document.activeElement
        const root = active instanceof HTMLIFrameElement ? active.closest<HTMLElement>('[data-code-root]')?.dataset.codeRoot : undefined
        if (root !== undefined) onFocus(root)
      })
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [onFocus])

  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-[35] overflow-hidden">
      {targets.map((target) => {
        const box = boxes[target.root]
        return (
          <div key={target.root} data-code-root={target.root} hidden={box === undefined} style={box} className={`absolute bg-ink-950 ${dragging ? '' : 'pointer-events-auto'}`}>
            <CodeFrame target={target} visible={box !== undefined} goto={gotos[target.root] ?? null} />
          </div>
        )
      })}
    </div>
  )
}
