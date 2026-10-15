import type { Dispatch, Worktree } from '@/api/schema'

// Placeholder: one column per parent session, its children collapsed inside it, is its own piece of
// work. It receives every open chat and the worktrees, and reports the chat the person opens.
export function Columns({ chats }: { chats: Dispatch[]; worktrees: Worktree[]; selected: string | null; onSelect: (dispatchId: string) => void }) {
  return <div className="p-10 text-ink-500">Columns view: {chats.length} chats.</div>
}
