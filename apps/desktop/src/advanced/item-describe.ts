import type { NativeChat, Project, ProjectSession, Status } from '@/api/schema'
import { displayName } from '@/advanced/appearance-model'
import type { SidebarSessionRow } from '@/advanced/projects-model'
import type { MemberInfo } from '@/advanced/split-rows'
import { codeTargetForRoot } from '@/code/code-pane-model'
import { githubItemTitle, parseGithubItemId } from '@/github/review-model'
import { rowStatus } from '@/native-chat/chat-model'
import { parseItem } from '@/panes/pane-model'
import { terminalLabel, type AppTerminal } from '@/terminal/terminal-list'

// What the window knows about the item a pane shows: the worktree it works in and how its row reads.
// Plain functions of the lists they read, so describing a split's members never depends on the order
// the window declares things in (a split once read `rootOf` before it existed and blanked the window).

export interface ItemSources {
  status: Pick<Status, 'dispatches'> | null
  sessionRows: SidebarSessionRow[]
  findSession: (sessionId: string) => { session: ProjectSession; worktreePath: string } | null
  nativeChats: NativeChat[]
  startedChat: NativeChat | null
  terminals: AppTerminal[]
  launcherRoots: Record<string, string | null>
  projects: Project[]
  chatsInWorktrees: Record<string, NativeChat[]>
  terminalsInWorktrees: Record<string, AppTerminal[]>
}

function nativeChatOf(sources: ItemSources, id: string): NativeChat | null {
  return sources.nativeChats.find((entry) => entry.id === id) ?? (sources.startedChat?.id === id ? sources.startedChat : null)
}

/** The worktree an item works in: its top bar runs commands there and its run panel shows. */
export function itemRoot(sources: ItemSources, item: string): string | null {
  const parsed = parseItem(item)
  if (parsed === null) return null
  switch (parsed.kind) {
    case 'dispatch':
      return sources.status?.dispatches.find((entry) => entry.dispatchId === parsed.id)?.worktreePath ?? null
    case 'session': {
      const path = sources.findSession(parsed.id)?.worktreePath ?? ''
      return path === '' ? null : path
    }
    case 'native':
      return nativeChatOf(sources, parsed.id)?.cwd ?? null
    case 'terminal':
      return sources.terminals.find((entry) => entry.id === parsed.id)?.cwd ?? null
    case 'launcher':
      return sources.launcherRoots[item] ?? null
    case 'github':
      return parseGithubItemId(parsed.id)?.root ?? null
    case 'code':
      return parsed.id
    // The page runs the project's commands in its main checkout.
    case 'project':
      return parsed.id
    // The page spans a project's worktrees, so it runs nothing; nor do the Artifacts and Tasks pages.
    case 'knowledge':
    case 'artifact':
    case 'tasks':
      return null
  }
}

/** The worktree whose sidebar section an item's group sits in. */
function itemWorktree(sources: ItemSources, item: string): string | null {
  const parsed = parseItem(item)
  if (parsed === null) return null
  const keyOf = <T,>(lists: Record<string, T[]>, has: (entry: T) => boolean) => Object.entries(lists).find(([, list]) => list.some(has))?.[0] ?? null
  switch (parsed.kind) {
    case 'native':
      return keyOf(sources.chatsInWorktrees, (chat) => chat.id === parsed.id)
    case 'terminal':
      return keyOf(sources.terminalsInWorktrees, (terminal) => terminal.id === parsed.id)
    // A project's page spans its worktrees, so its group sits with no one worktree.
    case 'project':
    case 'knowledge':
    case 'artifact':
    case 'tasks':
      return null
    default: {
      const root = itemRoot(sources, item)
      return root === null || root === '' ? null : root
    }
  }
}

/** A split group's member as its sidebar row shows it (see split-rows.ts). */
export function describeItem(sources: ItemSources, item: string): MemberInfo {
  const parsed = parseItem(item)
  const worktree = itemWorktree(sources, item)
  if (parsed === null) return { title: 'Unknown', mark: { kind: 'launcher' }, state: 'ended', worktree }
  switch (parsed.kind) {
    case 'dispatch': {
      const chat = sources.status?.dispatches.find((entry) => entry.dispatchId === parsed.id)
      const session = sources.sessionRows.find((row) => row.session.dispatchId === parsed.id)?.session
      return { title: chat?.label ?? session?.title ?? parsed.id, mark: { kind: 'agent', agent: chat?.agent ?? session?.agent ?? 'claude' }, state: session?.status ?? 'idle', worktree }
    }
    case 'session': {
      const session = sources.findSession(parsed.id)?.session
      return { title: session?.title ?? 'Session', mark: { kind: 'agent', agent: session?.agent ?? parsed.id.split(':', 1)[0] ?? 'claude' }, state: session?.status ?? 'ended', worktree }
    }
    case 'native': {
      const chat = nativeChatOf(sources, parsed.id)
      return { title: chat?.title ?? 'New chat', mark: { kind: 'agent', agent: chat?.agent ?? 'claude' }, state: chat === null ? 'ended' : rowStatus(chat.state), worktree }
    }
    case 'terminal': {
      const terminal = sources.terminals.find((entry) => entry.id === parsed.id)
      const state = terminal === undefined ? 'ended' : terminal.status === 'starting' ? 'working' : terminal.status === 'live' ? 'idle' : 'ended'
      return { title: terminal === undefined ? 'Terminal' : terminalLabel(terminal), mark: { kind: 'terminal' }, state, worktree }
    }
    // A launcher's worktree is only its current pick, so it does not decide where its group sits.
    case 'launcher':
      return { title: 'New chat', mark: { kind: 'launcher' }, state: 'idle', worktree: null }
    case 'github': {
      const target = parseGithubItemId(parsed.id)
      return { title: target === null ? 'GitHub' : githubItemTitle(target), mark: { kind: 'github' }, state: 'idle', worktree }
    }
    case 'code':
      return { title: codeTargetForRoot(sources.projects, parsed.id).title, mark: { kind: 'code' }, state: 'idle', worktree }
    case 'project': {
      const project = sources.projects.find((entry) => entry.path === parsed.id)
      return { title: project === undefined ? 'Project' : displayName(project), mark: { kind: 'project' }, state: 'idle', worktree }
    }
    case 'knowledge':
      return { title: 'Knowledge', mark: { kind: 'knowledge' }, state: 'idle', worktree }
    case 'artifact':
      return { title: 'Artifacts', mark: { kind: 'artifact' }, state: 'idle', worktree }
    case 'tasks':
      return { title: 'Tasks', mark: { kind: 'tasks' }, state: 'idle', worktree }
  }
}
