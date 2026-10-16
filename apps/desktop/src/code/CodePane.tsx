import { ChatHeader } from '@/chat/ChatHeader'
import type { CodeTarget } from '@/code/code-pane-model'

/** A worktree shown only in Code: its top bar with the action bar, whose Code view fills the rest. */
export function CodePane({ target }: { target: CodeTarget }) {
  return (
    <>
      <ChatHeader agent={null} title={target.title} />
      <div className="min-h-0 flex-1" />
    </>
  )
}
