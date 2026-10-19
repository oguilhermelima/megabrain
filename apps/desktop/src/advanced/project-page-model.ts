import type { BranchChanges, CodeChange, GithubCheck, GithubDetail, NativeChat, Project, ProjectScripts, ProjectSession } from '@/api/schema'
import { rowToOpen, worktreeItems, type KeyedItem } from '@/advanced/row-model'
import { worktreePullRequestState, type PullRequestVisualState } from '@/github/github-model'
import { rowStatus } from '@/native-chat/chat-model'
import type { WorktreePanel } from '@/run-panel/run-model'

// What a project's page shows, from the calls the sidebar already makes (`projects --json`, the
// native chats, `github prs|issues`, `repo scripts`): its worktrees, its chats across them, the
// newest pull requests and issues, and its three commands.

/** What a click on a worktree opens: its latest chat, else its launcher. */
export type WorktreeOpen = { kind: 'native'; chat: NativeChat } | { kind: 'session'; session: ProjectSession } | { kind: 'launcher' }

export interface WorktreeSummary {
  path: string
  /** The branch, or the commit a detached HEAD sits at. */
  name: string
  /** null on a detached HEAD. */
  branch: string | null
  primary: boolean
  pullRequest: { number: number; state: PullRequestVisualState | null; title: string | null } | null
  lastActivityAt: string | null
  /** Native chats and agent sessions, a chat that runs a listed session counted once. */
  chatCount: number
  /** Of those, the ones working now. */
  working: number
  open: WorktreeOpen
}

const itemStatus = (item: KeyedItem): ProjectSession['status'] | null => (item.kind === 'native' ? rowStatus(item.chat.state) : item.kind === 'session' ? item.session.status : null)

const itemActivity = (item: KeyedItem): string | null => (item.kind === 'native' ? (item.chat.lastActivityAt ?? item.session?.lastActivityAt ?? null) : (item.session?.lastActivityAt ?? null))

const newest = (dates: (string | null)[]): string | null => dates.reduce<string | null>((best, at) => (at !== null && (best === null || at > best) ? at : best), null)

/** Later first; one with no date goes last. */
const byRecent = (left: string | null, right: string | null) => (left === right ? 0 : left === null ? 1 : right === null ? -1 : left > right ? -1 : 1)

const worktreeName = (worktree: Project['worktrees'][number]) => worktree.branch ?? `Detached at ${(worktree.head ?? '').slice(0, 7)}`

/** The project's shown worktrees: the main checkout first, then the most recently active. */
export function worktreeSummaries(project: Project, chats: Record<string, NativeChat[]>): WorktreeSummary[] {
  const rows = project.worktrees
    .filter((worktree) => worktree.hidden !== true)
    .map((worktree): WorktreeSummary => {
      const items = worktreeItems(chats[worktree.path] ?? [], [], worktree.sessions)
      const latest = rowToOpen(items)
      const pullRequest = worktree.pullRequest
      return {
        path: worktree.path,
        name: worktreeName(worktree),
        branch: worktree.branch,
        primary: worktree.primary,
        pullRequest: pullRequest === null ? null : { number: pullRequest.number, state: worktreePullRequestState(pullRequest), title: pullRequest.title ?? null },
        lastActivityAt: newest(items.map(itemActivity)),
        chatCount: items.length,
        working: items.filter((item) => itemStatus(item) === 'working').length,
        open: latest === null || latest.kind === 'terminal' ? { kind: 'launcher' } : latest.kind === 'native' ? { kind: 'native', chat: latest.chat } : { kind: 'session', session: latest.session },
      }
    })
  return rows.sort((left, right) => Number(right.primary) - Number(left.primary) || byRecent(left.lastActivityAt, right.lastActivityAt))
}

export interface RecentChat {
  key: string
  title: string
  agent: string
  status: ProjectSession['status']
  at: string | null
  /** The worktree's branch it runs in, and its path. */
  worktree: string
  path: string
  open: Exclude<WorktreeOpen, { kind: 'launcher' }>
}

/** Every chat and session in the project's shown worktrees, the most recently active first. */
export function recentChats(project: Project, chats: Record<string, NativeChat[]>, limit: number): RecentChat[] {
  const rows = project.worktrees
    .filter((worktree) => worktree.hidden !== true)
    .flatMap((worktree) =>
      worktreeItems(chats[worktree.path] ?? [], [], worktree.sessions).flatMap((item): RecentChat[] => {
        const where = worktreeName(worktree)
        if (item.kind === 'native') {
          const { chat } = item
          return [{ key: item.key, title: chat.title ?? 'New chat', agent: chat.agent, status: rowStatus(chat.state), at: itemActivity(item), worktree: where, path: worktree.path, open: { kind: 'native', chat } }]
        }
        if (item.kind === 'session') {
          const { session } = item
          return [{ key: item.key, title: session.title, agent: session.agent, status: session.status, at: session.lastActivityAt, worktree: where, path: worktree.path, open: { kind: 'session', session } }]
        }
        return []
      }),
    )
  return rows.sort((left, right) => byRecent(left.at, right.at)).slice(0, limit)
}

/** The most recently updated first, the first `limit` of them. */
export function newestFirst<T extends { updatedAt: string }>(items: readonly T[], limit: number): T[] {
  return [...items].sort((left, right) => byRecent(left.updatedAt, right.updatedAt)).slice(0, limit)
}

export type ScriptAction = 'run' | 'build' | 'install'

export interface ScriptRow {
  action: ScriptAction
  label: string
  /** null when the project has none set and none was detected. */
  command: string | null
  /** Found in the project's files rather than saved in Settings. */
  detected: boolean
}

const scriptLabels: Record<ScriptAction, string> = { run: 'Run', build: 'Build', install: 'Install' }

export function scriptRows(scripts: ProjectScripts | null): ScriptRow[] {
  return (['run', 'build', 'install'] as const).map((action) => {
    const script = scripts?.scripts[action] ?? null
    return { action, label: scriptLabels[action], command: script?.command ?? null, detected: script?.source === 'detected' }
  })
}

/**
 * The branch the main checkout is on. `projects --json` carries no default branch; the main checkout
 * is where the person keeps it, so it stands in.
 */
export function defaultBranch(project: Project): string | null {
  return project.worktrees.find((worktree) => worktree.primary)?.branch ?? null
}

/** A worktree's changed files by kind, against its base: what it committed plus what is not committed yet. */
export interface ChangeCounts {
  added: number
  modified: number
  deleted: number
  /** Files with changes not committed yet, of all those counted. */
  uncommitted: number
}

type ChangeKind = 'added' | 'modified' | 'deleted'

const changeKind = (status: CodeChange['status']): ChangeKind => (status === 'added' || status === 'untracked' ? 'added' : status === 'deleted' ? 'deleted' : 'modified')

/**
 * Each path once. Uncommitted work says what a file is now, except that a file the branch added stays
 * added while it is still being edited, and one the branch added and the work then deleted is no change.
 */
export function changeCounts(uncommitted: readonly CodeChange[], branch: BranchChanges | null): ChangeCounts {
  const kinds = new Map<string, ChangeKind>((branch?.changes ?? []).map((change) => [change.path, changeKind(change.status)]))
  for (const change of uncommitted) {
    const now = changeKind(change.status)
    const before = kinds.get(change.path)
    if (before === 'added' && now === 'deleted') kinds.delete(change.path)
    else kinds.set(change.path, before === 'added' ? 'added' : now)
  }
  const counts: ChangeCounts = { added: 0, modified: 0, deleted: 0, uncommitted: new Set(uncommitted.map((change) => change.path)).size }
  for (const kind of kinds.values()) counts[kind] += 1
  return counts
}

export type ScriptState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'running' } | { kind: 'failed'; code: number | null } | { kind: 'stopped' }

/**
 * Where a command stands in the worktree's run panel: never run there (idle), starting (which also
 * covers a run waiting in megabrain's queue), running, or done. A run that ended on its own with a
 * code other than 0 failed; one stopped, or that exited cleanly, is stopped.
 */
export function scriptState(panel: WorktreePanel | null, action: ScriptAction): ScriptState {
  const tab = panel?.tabs.find((item) => item.action === action)
  if (tab === undefined) return { kind: 'idle' }
  if (tab.status.kind !== 'exited') return { kind: tab.status.kind }
  return tab.status.code !== null && tab.status.code !== 0 ? { kind: 'failed', code: tab.status.code } : { kind: 'stopped' }
}

/** A summary section's read: under way, answered, or failed. */
export type SummaryLoad<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; error: unknown }

/** What a pull request row shows beside its title: its review decision and checks. */
export interface PullDetail {
  checks: GithubCheck[]
  review: GithubDetail['reviewDecision'] | null
}

/** A pull request's detail as its row shows it; one that could not be read is unavailable, never one without checks. */
export function pullDetail(detail: Pick<GithubDetail, 'checks' | 'reviewDecision'> | null): PullDetail | 'unavailable' {
  if (detail === null) return 'unavailable'
  return { checks: detail.checks ?? [], review: detail.reviewDecision ?? null }
}

/** The Issues section's one line: how many are open once the count is known, or that it could not be read. */
export function issuesNote(load: SummaryLoad<{ counts: Record<string, number>; totalCount: number }>): string {
  if (load.state === 'failed') return 'Could not read the open issues.'
  if (load.state === 'loading') return 'Issues are listed on the Tasks page.'
  const open = load.value.counts.open ?? load.value.totalCount
  return open === 0 ? 'No open issues.' : `${open} open ${open === 1 ? 'issue' : 'issues'}, listed on the Tasks page.`
}

/** A worktree row's changes when they could not be read, so a failure never looks clean or blank. */
export const changesUnavailable = 'Changes unavailable'
