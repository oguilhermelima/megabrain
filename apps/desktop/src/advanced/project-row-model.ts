import type { NativeChat, Project, ProjectWorktree } from '@/api/schema'
import { rowStatus } from '@/native-chat/chat-model'

// A project's row in the sidebar is one button with two zones: its picture (a chevron on hover)
// folds the project, anywhere else opens the project's page. The keyboard does both: Enter opens,
// Left folds and Right unfolds. A mark beside the name says a chat in the project is working or
// waiting, so a folded project still shows it. A worktree row folds the same way, by its branch icon
// and the same keys.

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
  const hints = project.worktrees.map((worktree) => worktreeActivity(worktree, chats[worktree.path] ?? []))
  if (hints.some((hint) => hint?.state === 'working')) return 'working'
  return hints.some((hint) => hint !== null) ? 'waiting' : null
}

// A folded worktree shows the same mark, and how many of its chats and sessions are in that state.

export interface WorktreeActivity {
  state: 'working' | 'waiting'
  count: number
}

/** Working when any of the worktree's chats or sessions works, else waiting when one waits; null when neither. */
export function worktreeActivity(worktree: ProjectWorktree, chats: readonly NativeChat[]): WorktreeActivity | null {
  const states = [...worktree.sessions.map((session) => session.status), ...chats.map((chat) => rowStatus(chat.state))]
  for (const state of ['working', 'waiting'] as const) {
    const count = states.filter((entry) => entry === state).length
    if (count > 0) return { state, count }
  }
  return null
}

/** The folded worktree's mark's tooltip. */
export const worktreeActivityLabel = ({ state, count }: WorktreeActivity) =>
  `${count} ${count === 1 ? 'chat' : 'chats'} ${state === 'working' ? 'working' : 'waiting for you'}`
