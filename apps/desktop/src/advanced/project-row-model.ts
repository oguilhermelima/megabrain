import type { NativeChat, Project } from '@/api/schema'
import { rowStatus } from '@/native-chat/chat-model'

// A project's row in the sidebar is one button with two zones: its picture (a chevron on hover)
// folds the project, anywhere else opens the project's page. The keyboard does both: Enter opens,
// Left folds and Right unfolds. A mark beside the name says a chat in the project is working or
// waiting, so a folded project still shows it.

/** The row's left padding (10px) and the 24px picture: the part that folds. */
export const collapseZonePx = 34

export type ProjectRowAction = 'collapse' | 'open'

/** What a click at `offsetX` from the row's left edge does; a click the keyboard made has no position and opens. */
export function projectRowClick(offsetX: number, keyboard: boolean): ProjectRowAction {
  return !keyboard && offsetX < collapseZonePx ? 'collapse' : 'open'
}

/** What a key on the row does; null leaves it to the row's other handlers (⌥↑ ⌥↓ reorder). */
export function projectRowKey(key: string, collapsed: boolean, modifiers: { altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): 'open' | 'collapse' | 'expand' | null {
  if (modifiers.altKey || modifiers.metaKey || modifiers.ctrlKey || modifiers.shiftKey) return null
  if (key === 'Enter') return 'open'
  if (key === 'ArrowLeft' && !collapsed) return 'collapse'
  if (key === 'ArrowRight' && collapsed) return 'expand'
  return null
}

/** Working when any chat or session of the project works, else waiting when one waits for approval. */
export function projectActivity(project: Project, chats: Record<string, NativeChat[]>): 'working' | 'waiting' | null {
  const states = project.worktrees.flatMap((worktree) => [...worktree.sessions.map((session) => session.status), ...(chats[worktree.path] ?? []).map((chat) => rowStatus(chat.state))])
  if (states.includes('working')) return 'working'
  return states.includes('waiting') ? 'waiting' : null
}
