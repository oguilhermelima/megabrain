import { memo, type ReactNode } from 'react'
import type { NativeChat, Project, ProjectSession } from '@/api/schema'
import { visibleTree, worktreeTree, type WorktreeNode } from '@/advanced/stacks'
import type { StackDetails } from '@/advanced/useStackDetails'
import { stackFoldKey, worktreeFoldKey } from '@/advanced/sidebar-state'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { displayName, projectTint } from '@/advanced/appearance-model'
import type { PendingWorktree } from '@/advanced/new-worktree-model'
import { projectActivity, projectRowClick, projectRowKey } from '@/advanced/project-row-model'
import { Collapse } from '@/components/Collapse'
import { Spinner } from '@/components/ui'
import { AgentTint } from '@/components/agent-icons'
import { codeTargetFor, type CodeTarget } from '@/code/code-pane-model'
import { githubRepository } from '@/github/github-model'
import type { GithubKind } from '@/github/useGithubCounts'
import type { MenuItem } from '@/components/ContextMenu'
import { ActivityDot, BranchIcon, Chevron } from '@/advanced/chrome'
import { noChats, noTerminals, MoreButton, RowActions, type MenuOpener, type RowDragger } from '@/advanced/SidebarRows'
import { DropLine, type ProjectDrag } from '@/advanced/SidebarSections'
import { noGroups, WorktreeRow, type ItemRows, type TerminalRows } from '@/advanced/WorktreeRow'
import { GroupRowView, useSplitRows } from '@/advanced/SplitRows'
import type { AppTerminal } from '@/terminal/terminal-list'
import type { DropPlacement } from '@/advanced/sidebar-folders'

/** What every pending worktree row needs; the same object every render. */
export interface CreationRows {
  retry: (id: string) => void
  dismiss: (id: string) => void
}

/**
 * A worktree being created, shown where it will appear: creating while megabrain runs, opening once
 * it answered and the list catches up, and its error with a retry when it failed.
 */
function PendingWorktreeRow({ creation, rows }: { creation: PendingWorktree; rows: CreationRows }) {
  const failed = creation.status === 'failed'
  return (
    <div className="space-y-1">
      <div role="status" aria-busy={!failed} title={`${creation.branch} from ${creation.base}${creation.error === null ? '' : `\n${creation.error}`}`} className="group flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-[15px]">
        <span className={`shrink-0 ${failed ? 'text-bad' : 'text-ink-400'}`}>
          <BranchIcon />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13.5px] ${failed ? 'text-ink-300' : 'text-ink-400'}`}>{creation.branch}</span>
        {failed ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => rows.retry(creation.id)} className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-200 hover:bg-white/[0.1] hover:text-ink-100">
              Retry
            </button>
            <button type="button" onClick={() => rows.dismiss(creation.id)} aria-label={`Dismiss ${creation.branch}`} title="Dismiss" className="grid size-6 place-items-center rounded-full text-ink-400 hover:bg-white/[0.1] hover:text-ink-100">
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-400">
            {creation.status === 'creating' ? 'creating' : 'opening'}
            <Spinner />
          </span>
        )}
      </div>
      {failed && creation.error !== null && <p className="truncate pl-[37px] pr-1.5 text-[11.5px] text-bad select-text">{creation.error}</p>}
    </div>
  )
}

// Memoised with stable callbacks: a status poll or another project's change leaves this row alone.
export const ProjectSection = memo(function ProjectSection({
  project,
  collapsed,
  onToggle,
  selectedSessionId,
  onSelectSession,
  actions,
  onMenu,
  now,
  drag,
  dragging,
  edge,
  selected,
  onOpenProject,
  onGithub,
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  terminals,
  terminalRows,
  onDragRow,
  itemRows,
  creations,
  creationRows,
  listed,
  stacks,
}: {
  /** The project as megabrain lists it, hidden and filtered worktrees included, so stack positions count every branch. */
  listed: Project
  stacks: StackRows
  onDragRow: RowDragger
  itemRows: ItemRows
  /** Worktrees being created in this project. */
  creations: PendingWorktree[]
  creationRows: CreationRows
  project: Project
  now: number
  /** Terminals by worktree path. */
  terminals: Record<string, AppTerminal[]>
  terminalRows: TerminalRows
  /** Native chats by worktree path. */
  chats: Record<string, NativeChat[]>
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  onNewChat: (worktreePath: string) => void
  drag: ProjectDrag
  /** This row is the one being dragged. */
  dragging: boolean
  /** Where a dragged project would land against this row. */
  edge: DropPlacement | null
  /** The project's page is in the focused pane. */
  selected: boolean
  onOpenProject: (project: Project) => void
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
  collapsed: boolean
  /** Folds or unfolds the project by its path. */
  onToggle: (path: string) => void
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  actions: SidebarActions
  onMenu: MenuOpener
}) {
  const splits = useSplitRows()
  if (project.missing) {
    return (
      <section
        data-entry-key={project.path}
        onContextMenu={(event) => onMenu(event, actions.project(project))}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group relative flex h-9 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 select-none hover:bg-row-hover ${dragging ? 'opacity-50' : ''}`}
        title={`${displayName(project)}\n${project.path}`}
      >
        {edge !== null && <DropLine edge={edge} />}
        <ProjectPicture project={project} />
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-400">{displayName(project)}</h2>
        <span className="shrink-0 text-[11px] text-ink-400">folder missing</span>
        <RowActions gap="2.5">
          <MoreButton label={`Manage ${displayName(project)}`} onClick={(event) => onMenu(event, actions.project(project))} />
        </RowActions>
      </section>
    )
  }
  const shownPaths = new Set(project.worktrees.map((worktree) => worktree.path))
  const tree = worktreeTree(listed)
  const nodes = visibleTree(tree, (worktree) => shownPaths.has(worktree.path))
  const details = stacks.details[project.path]
  // A stack nests under its base: a line runs from each parent's branch icon down to its last child's,
  // with a tick into each child; a parent folds the branches stacked on it.
  const renderNodes = (list: WorktreeNode[]): ReactNode =>
    list.map((node, index) => {
      const { worktree } = node
      const foldKey = stackFoldKey(worktree.path)
      const open = !stacks.folded.has(foldKey)
      const rowsKey = worktreeFoldKey(worktree.path)
      const last = index === list.length - 1
      return (
        <div key={worktree.path} className="relative">
          {node.place !== null && node.place.position > 1 && (
            <>
              <span aria-hidden="true" className={`pointer-events-none absolute -top-1 left-[8px] w-px bg-white/[0.14] ${last ? 'h-5' : 'bottom-0'}`} />
              <span aria-hidden="true" className="pointer-events-none absolute top-4 left-[8px] h-px w-[6px] bg-white/[0.14]" />
            </>
          )}
          <div className="relative">
            {node.children.length > 0 && open && <span aria-hidden="true" className="pointer-events-none absolute top-[26px] bottom-0 left-[22px] w-px bg-white/[0.14]" />}
            <WorktreeRow
              worktree={worktree}
              place={node.place}
              detail={worktree.branch === null ? undefined : details?.[worktree.branch]}
              busy={stacks.busy[worktree.path] ?? null}
              fold={node.children.length === 0 ? null : { open, toggle: () => stacks.fold(foldKey) }}
              folded={stacks.folded.has(rowsKey)}
              onToggle={() => stacks.fold(rowsKey)}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              menuItems={actions.worktree(project, node, tree)}
              chatItems={actions.chat}
              sessionItems={actions.session}
              onMenu={onMenu}
              onCode={() => actions.code(codeTargetFor(project, worktree))}
              onPullRequest={githubRepository(project.remote) === null || worktree.pullRequest === null ? null : () => onGithub(project, 'prs', worktree.pullRequest?.number)}
              now={now}
              chats={chats[worktree.path] ?? noChats}
              selectedChatId={selectedChatId}
              onSelectChat={onSelectChat}
              onNewChat={onNewChat}
              terminals={terminals[worktree.path] ?? noTerminals}
              terminalRows={terminalRows}
              onDrag={onDragRow}
              rows={itemRows}
            />
          </div>
          {node.children.length > 0 && (
            <Collapse open={open}>
              <div className="relative space-y-1 pt-1 pl-[14px]">{renderNodes(node.children)}</div>
            </Collapse>
          )}
        </div>
      )
    })
  const activity = projectActivity(project, chats)
  const name = displayName(project)
  return (
    <section data-entry-key={project.path} className={`relative ${dragging ? 'opacity-50' : ''}`}>
      {edge !== null && <DropLine edge={edge} />}
      <div
        onContextMenu={(event) => onMenu(event, actions.project(project))}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none ${selected ? 'bg-row-selected' : 'hover:bg-row-hover'}`}
      >
        {/* One button, two zones (project-row-model): the picture, a chevron on hover, folds; the rest opens the page. */}
        <button
          type="button"
          data-entry-toggle={project.path}
          onClick={(event) => {
            const action = projectRowClick(event.clientX - event.currentTarget.getBoundingClientRect().left, event.detail === 0)
            if (action === 'collapse') onToggle(project.path)
            else onOpenProject(project)
          }}
          onKeyDown={(event) => {
            const action = projectRowKey(event.key, collapsed, event)
            if (action === null) return drag.key(event, project.path)
            event.preventDefault()
            if (action === 'open') onOpenProject(project)
            else onToggle(project.path)
          }}
          aria-expanded={!collapsed}
          aria-current={selected ? 'page' : undefined}
          aria-keyshortcuts="Enter ArrowLeft ArrowRight Alt+ArrowUp Alt+ArrowDown"
          title={`${name}\n${project.path}\nClick to open its page; click the picture or press ← → to fold\nDrag or press ⌥↑ ⌥↓ to reorder`}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
        >
          <span className="group/fold relative -ml-2.5 flex h-9 shrink-0 items-center pl-2.5">
            <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
              <ProjectPicture project={project} />
            </span>
            <span aria-hidden="true" className="absolute inset-y-0 right-0 grid w-6 place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
              <Chevron open={!collapsed} />
            </span>
          </span>
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink-100">{name}</h2>
          {activity !== null && <ActivityDot state={activity} title={activity === 'working' ? 'A chat is working' : 'A chat is waiting for you'} />}
        </button>
        <RowActions gap="0.5">
          <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, actions.project(project))} />
        </RowActions>
      </div>
      <Collapse open={!collapsed}>
        {/* The project's colour reaches only the agent marks of its chats and sessions. */}
        <AgentTint.Provider value={projectTint(project)}>
          <div className="space-y-1 pt-1">
            {/* A split across this project's worktrees sits above them. */}
            {(splits?.byProject.get(project.path) ?? noGroups).map((row) => (
              <div key={row.id} className="sidebar-row-in relative">
                <GroupRowView row={row} indent="top" onMenu={onMenu} drag={itemRows} end={(items) => <MoreButton label={`Manage ${row.title}`} onClick={(event) => onMenu(event, items)} />} />
              </div>
            ))}
            {renderNodes(nodes)}
            {creations.map((creation) => (
              <PendingWorktreeRow key={creation.id} creation={creation} rows={creationRows} />
            ))}
          </div>
        </AgentTint.Provider>
      </Collapse>
    </section>
  )
})

/** What the stacked rows need: details read from `stack show`, folds of stacks and worktrees, and actions running; one object per change. */
export interface StackRows {
  details: StackDetails
  folded: ReadonlySet<string>
  fold: (key: string) => void
  /** A running stack action's word by worktree path. */
  busy: Record<string, string>
}

export interface SidebarActions {
  code: (target: CodeTarget) => void
  project: (project: Project) => MenuItem[]
  /** `tree` is the project's whole worktree tree, which a stack action reads its chain from. */
  worktree: (project: Project, node: WorktreeNode, tree: WorktreeNode[]) => MenuItem[]
  chat: (chat: NativeChat) => MenuItem[]
  session: (session: ProjectSession) => MenuItem[]
}

