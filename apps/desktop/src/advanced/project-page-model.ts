import type { NativeChat, Project, ProjectScripts, ProjectSession } from '@/api/schema'
import { rowToOpen, worktreeItems, type KeyedItem } from '@/advanced/row-model'
import { worktreePullRequestState, type PullRequestVisualState } from '@/github/github-model'
import { rowStatus } from '@/native-chat/chat-model'

// What a project's page shows, from the calls the sidebar already makes (`projects --json`, the
// native chats, `github prs|issues`, `repo scripts`): its worktrees, its chats across them, the
// newest pull requests and issues, and its three commands.

/** What a click on a worktree opens: its latest chat, else its launcher. */
export type WorktreeOpen = { kind: 'native'; chat: NativeChat } | { kind: 'session'; session: ProjectSession } | { kind: 'launcher' }

export interface WorktreeSummary {
  path: string
  /** The branch, or the commit a detached HEAD sits at. */
  name: string
  primary: boolean
  pullRequest: { number: number; state: PullRequestVisualState | null; title: string | null } | null
  lastActivityAt: string | null
  /** Native chats and agent sessions, a chat that runs a listed session counted once. */
  chatCount: number
  open: WorktreeOpen
}

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
        primary: worktree.primary,
        pullRequest: pullRequest === null ? null : { number: pullRequest.number, state: worktreePullRequestState(pullRequest), title: pullRequest.title ?? null },
        lastActivityAt: newest(items.map(itemActivity)),
        chatCount: items.length,
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
