import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { api } from '@/api'
import type { Project, ProjectSession, ProjectWorktree, Status } from '@/api/schema'
import { projectWorktreeRows, relativeAge, sortSessions } from '@/advanced/projects-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { dropTarget, moveProject, reconcileOrder, stepProject, type Placement } from '@/advanced/project-order'
import { PlusIcon } from '@/advanced/chrome'
import { ConfirmDialog, RowMenu, type MenuItem, type OpenMenu, type PendingConfirm } from '@/advanced/RowMenu'
import { FilterMenu, HeaderButton, SearchField, SearchIcon } from '@/advanced/SidebarTools'
import { activeFilterLabels, emptyFilters, filterProjects, hasFilters, parseFilters, partitionHidden, sessionTimer, type HiddenPartition, type SidebarFilters } from '@/advanced/sidebar-model'
import { ErrorNote, Spinner } from '@/components/ui'
import { AgentIcon } from '@/components/agent-icons'
import { codeTargetFor, type CodeTarget } from '@/code/code-mode-model'
import { countBadge, githubRepository, stateColors, worktreePullRequestState } from '@/github/github-model'
import { IssueIcon, PullRequestIcon } from '@/github/icons'
import { useGithubCounts, type GithubCounts, type GithubKind } from '@/github/useGithubCounts'

const filtersKey = 'megabrain.sidebar.filters'

export function readFilters(): SidebarFilters {
  try {
    return parseFilters(localStorage.getItem(filtersKey))
  } catch {
    return emptyFilters
  }
}

export function writeFilters(filters: SidebarFilters) {
  try {
    localStorage.setItem(filtersKey, JSON.stringify(filters))
  } catch {
    // Remembered filters are a convenience; starting unfiltered is fine.
  }
}

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem('megabrain.sidebar.collapsed')
    return raw === null ? new Set() : new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

function writeCollapsed(collapsed: Set<string>) {
  try {
    localStorage.setItem('megabrain.sidebar.collapsed', JSON.stringify([...collapsed]))
  } catch {
    // A remembered collapse state is a convenience; starting expanded is fine.
  }
}

/** A worktree's pull request number, in its state's colour; opens that pull request's page. */
function PullRequestNumber({ pullRequest, color, title, onOpen }: { pullRequest: NonNullable<ProjectWorktree['pullRequest']>; color: string; title: string; onOpen: (() => void) | null }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      disabled={onOpen === null}
      title={title}
      aria-label={title}
      style={{ color }}
      className="shrink-0 rounded-full px-1.5 text-[11.5px] leading-6 font-semibold tabular-nums hover:bg-white/[0.08] disabled:cursor-default disabled:hover:bg-transparent"
    >
      #{pullRequest.number}
    </button>
  )
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="4" cy="3.2" r="1.6" />
      <circle cx="4" cy="12.8" r="1.6" />
      <circle cx="12" cy="7.5" r="1.6" />
      <path d="M4 4.8v6.4" />
      <path d="M4 7.5c0 2.5 2 2.5 6.4 2.5" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </svg>
  )
}

// A row's code and … buttons show on hover, while focus is inside the row, and while its menu is
// open (the row carries data-menu-open then), so they never vanish under the pointer or the keyboard.
const rowAction =
  'flex size-6 shrink-0 items-center justify-center rounded-full text-ink-300 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-data-[menu-open]:opacity-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:opacity-100'

/** Opens a root in Code mode; shown on hover like the … button beside it. */
function CodeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
      className={rowAction}
    >
      <CodeIcon />
    </button>
  )
}

/** Opens a row's menu at the pointer (right click) or under the … button. */
type MenuOpener = (event: MouseEvent<HTMLElement>, items: MenuItem[]) => void

function MoreButton({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      className={rowAction}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
      </svg>
    </button>
  )
}

/** Opens the project's pull request or issue page; the badge is the open count. */
function GithubButton({ kind, label, count, active, onClick }: { kind: GithubKind; label: string; count: number | null; active: boolean; onClick: () => void }) {
  const badge = count === null ? null : countBadge(count)
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      aria-label={badge === null ? label : `${label}, ${count} open`}
      title={badge === null ? label : `${label} · ${count} open`}
      aria-pressed={active}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition-colors ${active ? 'bg-accent/[0.22] text-ink-100' : 'text-ink-400 hover:bg-white/[0.1] hover:text-ink-100'}`}
    >
      {kind === 'prs' ? <PullRequestIcon size={14} /> : <IssueIcon size={14} />}
      {badge !== null && <span className={active ? 'text-ink-100' : 'text-ink-300'}>{badge}</span>}
    </button>
  )
}

const prStateNames = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' } as const

function pullRequestTitle(pullRequest: NonNullable<ProjectWorktree['pullRequest']>, state: keyof typeof prStateNames): string {
  const title = pullRequest.title !== undefined && pullRequest.title !== null && pullRequest.title !== '' ? `${pullRequest.title} · ` : ''
  return `#${pullRequest.number} · ${title}${prStateNames[state]}`
}

const sessionDot: Record<ProjectSession['status'], string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-400',
  ended: 'bg-ink-600',
}

const live = (session: ProjectSession) => session.status !== 'ended'

const timerTone = { normal: 'bg-white/[0.06] text-ink-300', amber: 'bg-warn/[0.14] text-warn', red: 'bg-bad/[0.16] text-bad' }

const timerHelp =
  'Claude keeps its prompt cache for one hour after the last activity; after that the next message re-reads the whole context at full price. ' +
  'Claude also compacts an idle session on its own after about 54 minutes when its context is over its token minimum.'

/** The current time, moved forward every interval; the timers count down from it without refetching. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function TimerChip({ session, now }: { session: ProjectSession; now: number }) {
  const timer = sessionTimer(session, now)
  if (timer === null) return null
  return <span title={timerHelp} className={`shrink-0 rounded-full px-1.5 text-[10.5px] leading-[18px] font-semibold whitespace-nowrap tabular-nums ${timerTone[timer.level]}`}>{timer.text}</span>
}

function SessionRow({ session, selected, now, onSelect }: { session: ProjectSession; selected: boolean; now: number; onSelect: () => void }) {
  const age = relativeAge(session.lastActivityAt, now)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`${session.title} · ${session.agent} · ${session.status}`}
      // The title takes what is left; the time sits in a fixed right-aligned column before the dot, so
      // every row lines up at the right edge whether or not it has a timer.
      className={`flex w-full items-center gap-2 rounded-[12px] py-1.5 pr-2.5 pl-[30px] text-left text-[13px] transition-colors ${
        selected ? 'bg-accent/[0.18] text-ink-100' : live(session) ? 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-100' : 'text-ink-400 hover:bg-white/[0.06] hover:text-ink-200'
      }`}
    >
      <AgentIcon agent={session.agent} className="shrink-0 text-ink-300" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <TimerChip session={session} now={now} />
      <span className="w-[30px] shrink-0 text-right text-[11.5px] whitespace-nowrap text-ink-400 tabular-nums">{age}</span>
      <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[session.status]}`} aria-label={session.status} />
    </button>
  )
}

function WorktreeRow({
  worktree,
  depth,
  selectedSessionId,
  onSelectSession,
  menuItems,
  onMenu,
  onCode,
  onPullRequest,
  now,
}: {
  worktree: ProjectWorktree
  depth: number
  now: number
  /** Opens the worktree's pull request on the project's pull request page; null without GitHub. */
  onPullRequest: (() => void) | null
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  menuItems: MenuItem[]
  onMenu: MenuOpener
  onCode: () => void
}) {
  const running = worktree.sessions.some(live)
  const name = worktree.branch === null ? `Detached HEAD at ${worktree.head ?? ''}` : worktree.branch
  const prState = worktreePullRequestState(worktree.pullRequest)
  const prColor = prState === null ? null : stateColors[prState]
  return (
    <div style={{ paddingLeft: `${depth * 14}px` }} className="space-y-0.5">
      <div onContextMenu={(event) => onMenu(event, menuItems)} className="group flex min-h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 hover:bg-white/[0.04]">
        <span style={prColor === null ? undefined : { color: prColor }} className={`shrink-0 ${running ? 'text-ink-300' : 'text-ink-400'}`}>
          <BranchIcon />
        </span>
        <span title={worktree.path} className={`min-w-0 truncate text-[14px] ${running ? 'font-medium text-ink-100' : 'text-ink-400'}`}>
          {name}
        </span>
        {worktree.primary && <span className="shrink-0 rounded-[7px] border border-white/[0.16] px-1.5 text-[11px] leading-[18px] text-ink-300">primary</span>}
        <span className="ml-auto" />
        {worktree.pullRequest !== null && prState !== null && prColor !== null && (
          <PullRequestNumber pullRequest={worktree.pullRequest} color={prColor} title={pullRequestTitle(worktree.pullRequest, prState)} onOpen={onPullRequest} />
        )}
        <CodeButton label={`Open ${name} in Code`} onClick={onCode} />
        <MoreButton label={`Manage ${name}`} onClick={(event) => onMenu(event, menuItems)} />
      </div>
      {sortSessions(worktree.sessions).map((session) => (
        <SessionRow key={session.sessionId} session={session} selected={session.sessionId === selectedSessionId} now={now} onSelect={() => onSelectSession(session)} />
      ))}
    </div>
  )
}

function ProjectSection({
  project,
  collapsed,
  onToggle,
  selectedSessionId,
  onSelectSession,
  actions,
  onMenu,
  now,
  drag,
  github,
}: {
  project: Project
  now: number
  drag: ProjectDrag
  github: ProjectGithub
  collapsed: boolean
  onToggle: () => void
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  actions: RowActions
  onMenu: MenuOpener
}) {
  const projectItems = actions.project(project)
  if (project.missing) {
    return (
      <section
        data-project-path={project.path}
        onContextMenu={(event) => onMenu(event, projectItems)}
        onPointerDown={(event) => drag.start(event, project.path)}
        className={`group relative flex items-center gap-2.5 rounded-[14px] py-1 pr-1.5 pl-2.5 select-none hover:bg-white/[0.04] ${drag.dragging(project.path) ? 'opacity-50' : ''}`}
        title={project.path}
      >
        {drag.edge(project.path) !== null && <DropLine edge={drag.edge(project.path) ?? 'before'} />}
        <ProjectPicture project={project} />
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink-400">{project.name}</h2>
        <span className="ml-auto shrink-0 text-[11.5px] text-ink-400">folder missing</span>
        <MoreButton label={`Manage ${project.name}`} onClick={(event) => onMenu(event, projectItems)} />
      </section>
    )
  }
  const rows = projectWorktreeRows(project)
  const running = project.worktrees.reduce((count, worktree) => count + worktree.sessions.filter(live).length, 0)
  const edge = drag.edge(project.path)
  return (
    <section data-project-path={project.path} className={`relative space-y-1 ${drag.dragging(project.path) ? 'opacity-50' : ''}`}>
      {edge !== null && <DropLine edge={edge} />}
      <div onContextMenu={(event) => onMenu(event, projectItems)} onPointerDown={(event) => drag.start(event, project.path)} className="group flex items-center gap-1 rounded-[14px] pr-1.5 select-none hover:bg-white/[0.04]">
        <button
          type="button"
          data-project-toggle={project.path}
          onClick={onToggle}
          onKeyDown={(event) => drag.key(event, project.path)}
          aria-expanded={!collapsed}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={`${project.path}\nDrag or press ⌥↑ ⌥↓ to reorder`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-left"
        >
          <ProjectPicture project={project} />
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{project.name}</h2>
          <span className="shrink-0 text-ink-400 opacity-0 group-hover:opacity-100">
            <Chevron open={!collapsed} />
          </span>
          {collapsed && running > 0 && <span className="ml-auto shrink-0 rounded-full bg-ok/[0.14] px-2 text-[11.5px] leading-5 font-semibold text-ok">{running}</span>}
        </button>
        {githubRepository(project.remote) !== null && (
          <>
            <GithubButton kind="prs" label={`${project.name} pull requests`} count={github.counts[project.path]?.prs ?? null} active={github.active?.path === project.path && github.active.kind === 'prs'} onClick={() => github.open(project, 'prs')} />
            <GithubButton kind="issues" label={`${project.name} issues`} count={github.counts[project.path]?.issues ?? null} active={github.active?.path === project.path && github.active.kind === 'issues'} onClick={() => github.open(project, 'issues')} />
          </>
        )}
        <CodeButton label={`Open ${project.name} in Code`} onClick={() => actions.code(codeTargetFor(project))} />
        <MoreButton label={`Manage ${project.name}`} onClick={(event) => onMenu(event, projectItems)} />
      </div>
      {!collapsed && (
        <div className="space-y-1.5 pl-2">
          {rows.map(({ worktree, depth }) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              depth={depth}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              menuItems={actions.worktree(project, worktree)}
              onMenu={onMenu}
              onCode={() => actions.code(codeTargetFor(project, worktree))}
              onPullRequest={githubRepository(project.remote) === null || worktree.pullRequest === null ? null : () => github.open(project, 'prs', worktree.pullRequest?.number)}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** The line that shows where a dragged project lands. */
function DropLine({ edge }: { edge: Placement }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent ${edge === 'before' ? '-top-1' : '-bottom-1'}`} />
}

/** What a project row needs to be dragged or moved with the keyboard. */
interface ProjectDrag {
  start: (event: PointerEvent<HTMLElement>, path: string) => void
  key: (event: KeyboardEvent<HTMLElement>, path: string) => void
  dragging: (path: string) => boolean
  edge: (path: string) => Placement | null
}

/** The release that ends a drag must not also toggle or open the row it lands on. */
function swallowNextClick() {
  const swallow = (event: globalThis.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

/** The GitHub icons of a project row: open counts, which page is showing, and how to open one. */
interface ProjectGithub {
  counts: GithubCounts
  active: { path: string; kind: GithubKind } | null
  open: (project: Project, kind: GithubKind, focus?: number) => void
}

interface RowActions {
  code: (target: CodeTarget) => void
  project: (project: Project) => MenuItem[]
  worktree: (project: Project, worktree: ProjectWorktree) => MenuItem[]
}

const worktreeName = (worktree: ProjectWorktree) => worktree.branch ?? `Detached HEAD at ${worktree.head ?? ''}`

function HiddenSection({ hidden, onShow }: { hidden: HiddenPartition; onShow: (target: { project: string } | { worktree: string }) => void }) {
  const [open, setOpen] = useState(false)
  const count = hidden.hiddenProjects.length + hidden.hiddenWorktrees.length
  if (count === 0) return null
  const row = (key: string, label: string, detail: string | null, target: { project: string } | { worktree: string }) => (
    <li key={key} className="group flex min-h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 hover:bg-white/[0.04]">
      <span className="min-w-0 truncate text-[13px] text-ink-300">{label}</span>
      {detail !== null && <span className="shrink-0 truncate text-[11.5px] text-ink-400">{detail}</span>}
      <button type="button" onClick={() => onShow(target)} className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-300 hover:bg-white/[0.1] hover:text-ink-100">
        Show
      </button>
    </li>
  )
  return (
    <section className="space-y-1 border-t border-white/[0.06] pt-3">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 text-left text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase hover:text-ink-200">
        <Chevron open={open} />
        Hidden
        <span className="ml-auto font-normal tracking-normal tabular-nums">{count}</span>
      </button>
      {open && (
        <ul className="space-y-0.5">
          {hidden.hiddenProjects.map((project) => row(`p:${project.path}`, project.name, 'project', { project: project.path }))}
          {hidden.hiddenWorktrees.map(({ project, worktree }) => row(`w:${worktree.path}`, worktreeName(worktree), project.name, { worktree: worktree.path }))}
        </ul>
      )}
    </section>
  )
}

// Every project the person works on, main checkout first with its worktrees and their stacks
// (see stack-model.ts), and the agent sessions running in each. Each project and worktree has a
// menu (right click or …) to hide it, remove it or open its code; hidden ones wait at the bottom.
export function Sidebar({
  status,
  projects,
  selectedSessionId,
  onSelectSession,
  onCode,
  onQuickView,
  onImport,
  onChanged,
  order,
  onReorder,
  filters,
  onFilters,
  activeGithub,
  onGithub,
}: {
  status: Status | null
  projects: Project[]
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  /** Opens a root in Code mode, the embedded VS Code. */
  onCode: (target: CodeTarget) => void
  /** The read-only file browser, without VS Code. */
  onQuickView: (target: CodeTarget) => void
  onImport: () => void
  /** Something was hidden, shown or removed; read the projects again. */
  onChanged: () => void
  /** The saved project order (paths), and where a drag or ⌥↑ ⌥↓ sends the new one. */
  order: string[]
  onReorder: (order: string[]) => void
  filters: SidebarFilters
  onFilters: (filters: SidebarFilters) => void
  /** The GitHub page showing in the main area, if any. */
  activeGithub: { path: string; kind: GithubKind } | null
  /** Opens a project's pull request or issue page. */
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const partition = partitionHidden(projects)
  const closeMenu = useCallback(() => setMenu(null), [])
  const now = useNow(30_000)
  const visible = filterProjects(partition.visible, filters)
  const githubCounts = useGithubCounts(partition.visible)
  const github: ProjectGithub = { counts: githubCounts, active: activeGithub, open: onGithub }
  const filtered = hasFilters(filters)
  const [searchOpen, setSearchOpen] = useState(filters.query !== '')
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = filters.query.trim() !== ''
  const openSearch = () => {
    setSearchOpen(true)
    searchRef.current?.focus()
  }
  const toggle = (name: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      writeCollapsed(next)
      return next
    })
  }

  const navRef = useRef<HTMLElement>(null)
  const [dragState, setDragState] = useState<{ path: string; target: { path: string; placement: Placement } | null } | null>(null)
  // Starting from every listed project keeps hidden and not-yet-ordered ones where they are.
  const fullOrder = () => reconcileOrder(order, projects.map((project) => project.path))
  const dropRows = () =>
    [...(navRef.current?.querySelectorAll<HTMLElement>('[data-project-path]') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect()
      return { path: element.dataset.projectPath ?? '', top: rect.top, bottom: rect.bottom }
    })

  const drag: ProjectDrag = {
    start: (event, path) => {
      if (event.button !== 0) return
      const startY = event.clientY
      let moving = false
      const onMove = (move: globalThis.PointerEvent) => {
        if (!moving && Math.abs(move.clientY - startY) < 4) return
        moving = true
        setDragState({ path, target: dropTarget(dropRows(), move.clientY) })
      }
      const onUp = (up: globalThis.PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        if (!moving) return
        swallowNextClick()
        setDragState(null)
        const target = dropTarget(dropRows(), up.clientY)
        if (target !== null && target.path !== path) onReorder(moveProject(fullOrder(), path, target.path, target.placement))
      }
      const onCancel = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        setDragState(null)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    key: (event, path) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      const current = fullOrder()
      const next = stepProject(current, visible.map((project) => project.path), path, event.key === 'ArrowUp' ? -1 : 1)
      if (next === current) return
      onReorder(next)
      // Moving the row re-inserts it in the list, which drops focus; give it back.
      requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-project-toggle="${CSS.escape(path)}"]`)?.focus())
    },
    dragging: (path) => dragState?.path === path,
    edge: (path) => (dragState?.target?.path === path && dragState.target.path !== dragState.path ? dragState.target.placement : null),
  }

  // The row whose menu is open keeps its actions visible; see rowAction.
  const menuRow = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const row = menuRow.current
    if (menu === null || row === null) return
    row.dataset.menuOpen = ''
    return () => {
      delete row.dataset.menuOpen
    }
  }, [menu])

  const openMenu: MenuOpener = (event, items) => {
    event.preventDefault()
    event.stopPropagation()
    menuRow.current = event.currentTarget.closest<HTMLElement>('.group')
    // A right click opens at the pointer; the … button opens the menu under itself.
    if (event.type === 'contextmenu') {
      setMenu({ anchor: { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY }, gap: 0, items })
      return
    }
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
    setMenu({ anchor: { left, top, right, bottom }, gap: 4, items })
  }

  const setHidden = (target: { project: string } | { worktree: string }, hidden: boolean) => {
    setActionError(null)
    api.setHidden(target, hidden).then(onChanged, setActionError)
  }

  const actions: RowActions = {
    code: onCode,
    project: (project) => [
      { label: 'Open Code', onSelect: () => onCode(codeTargetFor(project)) },
      { label: 'Quick view', onSelect: () => onQuickView(codeTargetFor(project)) },
      { label: 'Hide', onSelect: () => setHidden({ project: project.path }, true) },
      {
        label: 'Remove from megabrain…',
        danger: true,
        onSelect: () =>
          setConfirm({
            title: `Remove ${project.name} from megabrain?`,
            body: `megabrain stops listing this project. The folder and its files stay where they are (${project.path}); import it again with + to bring it back.`,
            action: 'Remove',
            run: () => api.removeProject(project.path),
          }),
      },
    ],
    worktree: (project, worktree) => {
      const name = worktreeName(worktree)
      const items: MenuItem[] = [
        { label: 'Open Code', onSelect: () => onCode(codeTargetFor(project, worktree)) },
        { label: 'Quick view', onSelect: () => onQuickView(codeTargetFor(project, worktree)) },
        { label: 'Hide', onSelect: () => setHidden({ worktree: worktree.path }, true) },
      ]
      // The main checkout is the project itself; it is removed with the project, not as a worktree.
      if (!worktree.primary) {
        items.push({
          label: 'Remove worktree…',
          danger: true,
          onSelect: () =>
            setConfirm({
              title: `Remove ${name}?`,
              body: `This deletes the folder ${worktree.path} and the branch ${worktree.branch ?? '(detached)'} from ${project.name}. megabrain refuses when the branch has work that is not merged, and nothing is deleted then.`,
              action: 'Remove worktree',
              run: () => api.removeWorktree(worktree.path),
            }),
        })
      }
      return items
    },
  }

  return (
    <nav
      ref={navRef}
      className="min-h-0 flex-1 space-y-6 overflow-y-auto px-2.5 pt-1 pb-6"
      aria-label="Projects"
      onKeyDown={(event) => {
        if (!event.metaKey || event.key.toLowerCase() !== 'f' || partition.visible.length === 0) return
        event.preventDefault()
        openSearch()
      }}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between pr-1.5 pl-2.5">
          <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">Projects</h3>
          <span className="flex items-center gap-0.5">
            {partition.visible.length > 0 && (
              <>
                <HeaderButton label="Search (⌘F)" on={searching} expanded={searchOpen} keepFocus onClick={() => (searchOpen && filters.query === '' ? setSearchOpen(false) : openSearch())}>
                  <SearchIcon />
                </HeaderButton>
                <FilterMenu filters={filters} onFilters={onFilters} />
              </>
            )}
            <button type="button" onClick={onImport} aria-label="Import project" title="Import project" className="flex size-7 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100">
              <PlusIcon />
            </button>
          </span>
        </div>
        {searchOpen && partition.visible.length > 0 && <SearchField inputRef={searchRef} query={filters.query} onQuery={(query) => onFilters({ ...filters, query })} onClose={() => setSearchOpen(false)} />}
      </div>
      {actionError !== null && (
        <div className="px-1">
          <ErrorNote error={actionError} />
        </div>
      )}
      {status === null && projects.length === 0 && (
        <div className="px-2.5 py-2">
          <Spinner />
        </div>
      )}
      {visible.map((project) => (
        <ProjectSection
          key={project.name}
          project={project}
          collapsed={collapsed.has(project.name)}
          onToggle={() => toggle(project.name)}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
          actions={actions}
          onMenu={openMenu}
          now={now}
          drag={drag}
          github={github}
        />
      ))}
      {filtered && visible.length === 0 && partition.visible.length > 0 && (
        <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
          <p className="text-[13.5px] text-ink-300">Nothing matches {activeFilterLabels(filters).join(' + ')}.</p>
          <button
            type="button"
            onClick={() => {
              onFilters(emptyFilters)
              setSearchOpen(false)
            }}
            className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
            Clear filters
          </button>
        </div>
      )}
      {projects.length === 0 && status !== null && (
        <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
          <p className="text-[13.5px] text-ink-300">No projects yet.</p>
          <button type="button" onClick={onImport} className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
            Import a project
          </button>
        </div>
      )}
      <HiddenSection hidden={partition} onShow={(target) => setHidden(target, false)} />
      {menu !== null && <RowMenu menu={menu} onClose={closeMenu} />}
      {confirm !== null && (
        <ConfirmDialog
          confirm={confirm}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null)
            onChanged()
          }}
        />
      )}
    </nav>
  )
}
