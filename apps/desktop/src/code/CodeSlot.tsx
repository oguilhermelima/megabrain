import { useCallback } from 'react'
import { Button } from '@/components/ui'
import type { CodeSlots } from '@/code/code-slots'

/**
 * A pane's Code view under its top bar. The pane that holds the root's frame leaves this empty and
 * the code layer lays VS Code over it; another pane showing the same root points to that one.
 */
export function CodeSlot({ item, holder, slots, onShowHolder }: { item: string; holder: string | null; slots: CodeSlots; onShowHolder: () => void }) {
  const slot = useCallback((element: HTMLDivElement | null) => slots.set(item, element), [slots, item])
  if (holder === item) return <div ref={slot} className="min-h-0 flex-1" />
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-[13.5px] text-ink-400">
      This worktree’s VS Code is open in the other pane.
      <Button variant="ghost" onClick={onShowHolder}>Open in the other pane</Button>
    </div>
  )
}
