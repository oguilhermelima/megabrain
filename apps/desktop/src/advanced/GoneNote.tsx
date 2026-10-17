import { pageX } from '@/lib/page'

/** A pane whose item is no longer listed: a dispatch that was pruned, a chat that ended elsewhere. */
export function GoneNote() {
  return (
    <div className={`flex min-h-0 flex-1 items-center justify-center ${pageX} text-center text-[13.5px] text-ink-400`}>
      This is no longer listed. Pick something in the sidebar or close the pane.
    </div>
  )
}
