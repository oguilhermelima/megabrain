import { useState } from 'react'
import type { Dispatch, Status, Worktree } from '@/api/schema'
import { chatState, type RepositoryGroup, type WorktreeGroup } from '@/advanced/model'
import { AgentBadge, StateDot, chatName } from '@/advanced/parts'
import { buildStackModel, flattenStack, type StackNode } from '@/advanced/stack-model'
import { Spinner } from '@/components/ui'

const folder = (path: string | null | undefined) => (path ?? '').split('/').at(-1) ?? ''

export interface CodeTarget {
  root: string
  title: string
}

const prChipClasses: Record<string, string> = {
  OPEN: 'bg-ok/20 text-ok',
  MERGED: 'bg-accent/20 text-accent',
  CLOSED: 'bg-white/10 text-ink-500',
}

function PullRequestBadge({ pullRequest }: { pullRequest: StackNode['pullRequest'] }) {
  if (pullRequest === null || pullRequest === undefined) return null
  // No in-app URL opener exists yet; render the number as plain text until one is added.
  return (
    <span className="flex items-center gap-1 text-[11.5px] font-semibold text-ink-400">
      #{pullRequest.number}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${prChipClasses[pullRequest.state] ?? 'bg-white/10 text-ink-500'}`}>{pullRequest.state}</span>
    </span>
  )
}

function StackedBranchRow({ node, onCode }: { node: StackNode; onCode: (target: CodeTarget) => void }) {
  return (
    <div className={`group flex items-center justify-between px-3 pt-1 ${node.isBase ? 'opacity-50' : ''}`}>
      <span className="flex items-center gap-2 truncate">
        <span className="truncate font-mono text-[11.5px] text-ink-500">{node.branch}</span>
        <PullRequestBadge pullRequest={node.pullRequest} />
      </span>
      {node.worktreePath !== null && <CodeButton onClick={() => onCode({ root: node.worktreePath ?? '', title: folder(node.worktreePath) })} />}
    </div>
  )
}

function Stack({
  root,
  chatsByPath,
  selected,
  onSelect,
  onCode,
}: {
  root: StackNode
  chatsByPath: Map<string, WorktreeGroup>
  selected: string | null
  onSelect: (dispatchId: string) => void
  onCode: (target: CodeTarget) => void
}) {
  return (
    <div className="space-y-0.5">
      {flattenStack(root).map((node) => {
        const chats = node.worktreePath === null ? [] : chatsByPath.get(node.worktreePath)?.chats ?? []
        return (
          <div key={`${node.branch}-${node.depth}`} style={{ paddingLeft: `${node.depth * 12}px` }}>
            <StackedBranchRow node={node} onCode={onCode} />
            {chats.map((item) => (
              <SidebarChat key={item.dispatchId} chat={item} selected={item.dispatchId === selected} onSelect={() => onSelect(item.dispatchId)} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

// Repositories, their worktrees and the chats in each. Each repository and worktree opens in Code.
// A repository whose worktrees form a chain of dependent branches (see stack-model.ts) shows the
// whole stack instead of separate unrelated rows.
export function Sidebar({
  status,
  repositories,
  repositoryPaths,
  worktrees,
  ended,
  selected,
  onSelect,
  onCode,
}: {
  status: Status | null
  repositories: RepositoryGroup[]
  /** The main checkout of each repository, by name, when megabrain knows it. */
  repositoryPaths: Map<string, string>
  worktrees: Worktree[]
  ended: Dispatch[]
  selected: string | null
  onSelect: (dispatchId: string) => void
  onCode: (target: CodeTarget) => void
}) {
  const [showEnded, setShowEnded] = useState(false)
  const { stacks, standalone } = buildStackModel(worktrees)
  const standalonePaths = new Set(standalone.map((worktree) => worktree.path))
  return (
    <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Chats">
      {status === null && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {repositories.map((repository) => {
        const repositoryPath = repositoryPaths.get(repository.name)
        const chatsByPath = new Map(repository.worktrees.map((worktree) => [worktree.path ?? '', worktree]))
        const repositoryStacks = stacks.filter((stack) => stack.repositoryName === repository.name)
        const standaloneWorktrees = repository.worktrees.filter((worktree) => worktree.path === null || standalonePaths.has(worktree.path))
        return (
          <section key={repository.name} className="space-y-1">
            <div className="group flex items-center justify-between px-3">
              <h2 className="text-[11.5px] font-semibold tracking-[0.07em] text-ink-500 uppercase">{repository.name}</h2>
              {repositoryPath !== undefined && <CodeButton onClick={() => onCode({ root: repositoryPath, title: repository.name })} />}
            </div>
            {repositoryStacks.map((stack) => (
              <Stack key={stack.root.branch} root={stack.root} chatsByPath={chatsByPath} selected={selected} onSelect={onSelect} onCode={onCode} />
            ))}
            {standaloneWorktrees.map((worktree) => (
              <div key={worktree.path ?? 'none'} className="space-y-0.5">
                <div className="group flex items-center justify-between px-3 pt-1">
                  <span className="truncate font-mono text-[11.5px] text-ink-500">{folder(worktree.path) || 'no worktree'}</span>
                  {worktree.path !== null && <CodeButton onClick={() => onCode({ root: worktree.path ?? '', title: folder(worktree.path) })} />}
                </div>
                {worktree.chats.map((item) => (
                  <SidebarChat key={item.dispatchId} chat={item} selected={item.dispatchId === selected} onSelect={() => onSelect(item.dispatchId)} />
                ))}
              </div>
            ))}
          </section>
        )
      })}
      {repositories.length === 0 && status !== null && <p className="px-3 text-[13px] text-ink-500">No open chats.</p>}
      {ended.length > 0 && (
        <section className="space-y-0.5">
          <button type="button" onClick={() => setShowEnded((value) => !value)} className="w-full rounded-xl px-3 py-1.5 text-left text-[13px] text-ink-500 hover:text-ink-300">
            {ended.length} ended, never closed {showEnded ? '▾' : '›'}
          </button>
          {showEnded && ended.map((item) => <SidebarChat key={item.dispatchId} chat={item} selected={item.dispatchId === selected} onSelect={() => onSelect(item.dispatchId)} />)}
        </section>
      )}
    </nav>
  )
}

function CodeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-500 opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-ink-200 focus-visible:opacity-100">
      Code
    </button>
  )
}

export function SidebarChat({ chat, selected, onSelect }: { chat: Dispatch; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[14px] px-3 py-2 text-left text-[14px] transition-colors ${
        selected ? 'bg-accent/[0.16] text-ink-100' : 'text-ink-200 hover:bg-white/[0.06]'
      }`}
    >
      <AgentBadge agent={chat.agent ?? ''} />
      <span className="truncate">{chatName(chat)}</span>
      <StateDot state={chatState(chat)} />
    </button>
  )
}
