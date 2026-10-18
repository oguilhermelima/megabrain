import type { NativeChat, Project, ProjectSession, Status } from '@/api/schema'
import { codeTargetForRoot } from '@/code/code-pane-model'
import { githubItemTitle, parseGithubItemId } from '@/github/review-model'
import { displayName } from '@/advanced/appearance-model'
import { rowStatus } from '@/native-chat/chat-model'
import { parseItem } from '@/panes/pane-model'
import { groupRows, type MemberInfo } from '@/advanced/split-rows'
import { terminalLabel, type AppTerminal } from '@/terminal/terminal-list'
import type { Layout } from '@/panes/split-groups'

export function useSplitRows({
  paneLayout, status, sessionRows, findSession, nativeChats, startedChat, terminals,
  chatsInWorktrees, terminalsInWorktrees, projects, rootOf,
}: {
  paneLayout: Layout
  status: Status | null
  sessionRows: { session: ProjectSession }[]
  findSession: (id: string) => { session: ProjectSession; worktreePath: string } | null
  nativeChats: NativeChat[]
  startedChat: NativeChat | null
  terminals: AppTerminal[]
  chatsInWorktrees: Record<string, NativeChat[]>
  terminalsInWorktrees: Record<string, AppTerminal[]>
  projects: Project[]
  rootOf: (item: string) => string | null
}) {
  const worktreeOfItem = (item: string): string | null => {
    const parsed = parseItem(item)
    if (parsed === null) return null
    const keyOf = <T,>(lists: Record<string, T[]>, has: (entry: T) => boolean) => Object.entries(lists).find(([, list]) => list.some(has))?.[0] ?? null
    switch (parsed.kind) {
      case 'native':
        return keyOf(chatsInWorktrees, (chat) => chat.id === parsed.id)
      case 'terminal':
        return keyOf(terminalsInWorktrees, (terminal) => terminal.id === parsed.id)
      // A project's page spans its worktrees, so its group sits with no one worktree.
      case 'project':
      case 'knowledge':
      case 'artifact':
      case 'tasks':
        return null
      default: {
        const root = rootOf(item)
        return root === null || root === '' ? null : root
      }
    }
  }
  const describeItem = (item: string): MemberInfo => {
    const parsed = parseItem(item)
    const worktree = worktreeOfItem(item)
    if (parsed === null) return { title: 'Unknown', mark: { kind: 'launcher' }, state: 'ended', worktree }
    switch (parsed.kind) {
      case 'dispatch': {
        const chat = status?.dispatches.find((entry) => entry.dispatchId === parsed.id)
        const session = sessionRows.find((row) => row.session.dispatchId === parsed.id)?.session
        return { title: chat?.label ?? session?.title ?? parsed.id, mark: { kind: 'agent', agent: chat?.agent ?? session?.agent ?? 'claude' }, state: session?.status ?? 'idle', worktree }
      }
      case 'session': {
        const session = findSession(parsed.id)?.session
        return { title: session?.title ?? 'Session', mark: { kind: 'agent', agent: session?.agent ?? parsed.id.split(':', 1)[0] ?? 'claude' }, state: session?.status ?? 'ended', worktree }
      }
      case 'native': {
        const chat = nativeChats.find((entry) => entry.id === parsed.id) ?? (startedChat?.id === parsed.id ? startedChat : null)
        return { title: chat?.title ?? 'New chat', mark: { kind: 'agent', agent: chat?.agent ?? 'claude' }, state: chat === null ? 'ended' : rowStatus(chat.state), worktree }
      }
      case 'terminal': {
        const terminal = terminals.find((entry) => entry.id === parsed.id)
        const state = terminal === undefined ? 'ended' : terminal.status === 'starting' ? 'working' : terminal.status === 'live' ? 'idle' : 'ended'
        return { title: terminal === undefined ? 'Terminal' : terminalLabel(terminal), mark: { kind: 'terminal' }, state, worktree }
      }
      case 'launcher':
        return { title: 'New chat', mark: { kind: 'launcher' }, state: 'idle', worktree: null }
      case 'github': {
        const target = parseGithubItemId(parsed.id)
        return { title: target === null ? 'GitHub' : githubItemTitle(target), mark: { kind: 'github' }, state: 'idle', worktree }
      }
      case 'code':
        return { title: codeTargetForRoot(projects, parsed.id).title, mark: { kind: 'code' }, state: 'idle', worktree }
      case 'project': {
        const project = projects.find((entry) => entry.path === parsed.id)
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
  return { describeItem, splitRowsValue: groupRows(paneLayout, describeItem) }
}
