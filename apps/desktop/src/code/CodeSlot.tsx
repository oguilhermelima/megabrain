import { useCallback } from 'react'
import { Button } from '@/components/ui'
import type { CodeSlots } from '@/code/code-slots'
import { pageX } from '@/lib/page'

/**
 * A pane's Code view under its top bar. The pane that holds the root's frame leaves this empty and
 * the code layer lays Code over it; another pane showing the same root points to that one.
 */
export function CodeSlot({ item, holder, slots, onShowHolder }: { item: string; holder: string | null; slots: CodeSlots; onShowHolder: () => void }) {
  const slot = useCallback((element: HTMLDivElement | null) => slots.set(item, element), [slots, item])
  if (holder === item) return <div ref={slot} className="min-h-0 flex-1" />
  return (
    <div className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-3 ${pageX} text-center text-[13.5px] text-ink-400`}>
      This worktree is open in Code in the other pane.
      <Button variant="ghost" onClick={onShowHolder}>Open in the other pane</Button>
    </div>
  )
}
