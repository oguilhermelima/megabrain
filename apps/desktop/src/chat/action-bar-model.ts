import type { BranchChanges, CodeChange, Project, ProjectWorktree } from '@/api/schema'
import type { ItemKind } from '@/panes/pane-model'

// The action bar centred in a pane's top bar: four views of the item's worktree, all shown in the
// pane under the bar. Agent is the chat or session itself, Code the worktree's editor, PR the
// branch's pull request and Diff its changes. PR and Diff are disabled while there is nothing to show.

export type PaneView = 'agent' | 'code' | 'pr' | 'diff'
export const paneViews: readonly PaneView[] = ['agent', 'code', 'pr', 'diff']

/** What the bar knows about a worktree: where it is, its branch and repository, and its pull request. */
export interface WorktreeFacts {
  root: string
  /** The repository the GitHub commands run against: the project's own checkout. */
  repo: string
  branch: string | null
  parent: string | null
  pullRequest: number | null
}

export function worktreeFacts(projects: readonly Project[], root: string): WorktreeFacts {
  for (const project of projects) {
    const worktree: ProjectWorktree | undefined = project.worktrees.find((candidate) => candidate.path === root)
    if (worktree !== undefined) return { root, repo: project.path, branch: worktree.branch, parent: worktree.parent, pullRequest: worktree.pullRequest?.number ?? null }
  }
  return { root, repo: root, branch: null, parent: null, pullRequest: null }
}

/** Every path changed, uncommitted or committed on the branch, counted once. */
export function changedFileCount(uncommitted: readonly CodeChange[], branch: BranchChanges | null): number {
  return new Set([...uncommitted.map((change) => change.path), ...(branch?.changes ?? []).map((change) => change.path)]).size
}

export interface Segment {
  view: PaneView
  label: string
  enabled: boolean
  /** The tooltip: the action, or why it is disabled. */
  title: string
  badge: string | null
}

export function segments({ facts, changed, codeAvailable }: { facts: WorktreeFacts; changed: number | null; codeAvailable: boolean }): Segment[] {
  const branch = facts.branch ?? 'this worktree'
  return [
    { view: 'agent', label: 'Agent', enabled: true, title: 'Agent (⌘1)', badge: null },
    { view: 'code', label: 'Code', enabled: codeAvailable, title: codeAvailable ? `Open ${branch} in Code (⌘2)` : 'Code is not available here', badge: null },
    facts.pullRequest === null
      ? { view: 'pr', label: 'PR', enabled: false, title: `No pull request for ${branch}`, badge: null }
      : { view: 'pr', label: 'PR', enabled: true, title: `Pull request #${facts.pullRequest} (⌘3)`, badge: `#${facts.pullRequest}` },
    changed === null || changed === 0
      ? { view: 'diff', label: 'Diff', enabled: false, title: changed === null ? 'Reading changes…' : 'No changes', badge: null }
      : { view: 'diff', label: 'Diff', enabled: true, title: `${changed} changed ${changed === 1 ? 'file' : 'files'} (⌘4)`, badge: String(changed) },
  ]
}

/**
 * The view the pane shows: the chosen one while it is enabled, else Agent, so a pull request that
 * closes or a diff that is committed and merged away falls back instead of showing nothing.
 */
export function shownView(chosen: PaneView, available: readonly Segment[]): PaneView {
  if (chosen === 'agent') return 'agent'
  return available.find((segment) => segment.view === chosen)?.enabled === true ? chosen : 'agent'
}

/** The view an item opens on: a code item is its worktree's Code, anything else its agent. */
export function initialView(kind: ItemKind): PaneView {
  return kind === 'code' ? 'code' : 'agent'
}

/** What choosing a view does: switch the pane's view, or, on a code item, which has no agent of its
 * own, Agent opens the launcher for its worktree in that pane. */
export function chooseView(kind: ItemKind, view: PaneView): { kind: 'view'; view: PaneView } | { kind: 'launcher' } {
  return kind === 'code' && view === 'agent' ? { kind: 'launcher' } : { kind: 'view', view }
}

/** ⌘1 to ⌘4 pick a view; anything else, a modifier besides ⌘ included, is not the bar's. */
export function viewForKey(event: { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): PaneView | null {
  if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return null
  const index = ['1', '2', '3', '4'].indexOf(event.key)
  return index === -1 ? null : (paneViews[index] ?? null)
}

/** The focused pane's bar takes ⌘1 to ⌘4, but never while the keyboard is in Code, whose own
 * ⌘1 to ⌘3 focus its editor groups. */
export function paneViewKey(event: Parameters<typeof viewForKey>[0], where: { focused: boolean; inEditor: boolean }): PaneView | null {
  return where.focused && !where.inEditor ? viewForKey(event) : null
}
