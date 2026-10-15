import { useState } from 'react'
import type { Project, ProjectSession, ProjectWorktree, Status } from '@/api/schema'
import { projectWorktreeRows, relativeAge, sortSessions } from '@/advanced/projects-model'
import { AgentBadge } from '@/advanced/parts'
import { Spinner } from '@/components/ui'

const folder = (path: string | null | undefined) => (path ?? '').split('/').at(-1) ?? ''

export interface CodeTarget {
  root: string
  title: string
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

const prChipClasses: Record<string, string> = {
  OPEN: 'bg-ok/20 text-ok',
  MERGED: 'bg-accent/20 text-accent',
  CLOSED: 'bg-white/10 text-ink-500',
}

function PullRequestBadge({ pullRequest }: { pullRequest: ProjectWorktree['pullRequest'] }) {
  if (pullRequest === null) return null
  return (
    <span className="flex items-center gap-1 text-[11.5px] font-semibold text-ink-400">
      #{pullRequest.number}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${prChipClasses[pullRequest.state] ?? 'bg-white/10 text-ink-500'}`}>{pullRequest.state}</span>
    </span>
  )
}

function CodeButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-500 opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-ink-200 focus-visible:opacity-100">
      Code
    </button>
  )
}

const sessionDot: Record<ProjectSession['status'], string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-500',
  ended: 'bg-ink-700',
}

function SessionRow({ session, selected, onSelect }: { session: ProjectSession; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-[14px] px-3 py-2 text-left text-[14px] transition-colors ${
        selected ? 'bg-accent/[0.16] text-ink-100' : 'text-ink-200 hover:bg-white/[0.06]'
      }`}
    >
      <AgentBadge agent={session.agent} />
      <span className="truncate">{session.title}</span>
      <span className="text-[11.5px] text-ink-500">{relativeAge(session.lastActivityAt)}</span>
      <span className={`size-2 shrink-0 rounded-full ${sessionDot[session.status]}`} aria-label={session.status} />
    </button>
  )
}

function WorktreeRow({
  worktree,
  depth,
  selectedSessionId,
  onSelectSession,
  onCode,
}: {
  worktree: ProjectWorktree
  depth: number
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  onCode: (target: CodeTarget) => void
}) {
  const dimmed = worktree.sessions.length === 0
  return (
    <div style={{ paddingLeft: `${depth * 12}px` }} className="space-y-0.5">
      <div className={`group flex items-center justify-between px-3 pt-1 ${dimmed ? 'opacity-50' : ''}`}>
        <span className="flex min-w-0 items-center gap-2 truncate">
          {worktree.primary && <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-400">primary</span>}
          <span className="truncate font-mono text-[11.5px] text-ink-500">{worktree.branch === null ? `Detached HEAD at ${worktree.head ?? ''}` : worktree.branch}</span>
          <PullRequestBadge pullRequest={worktree.pullRequest} />
        </span>
        <CodeButton onClick={() => onCode({ root: worktree.path, title: folder(worktree.path) })} />
      </div>
      {sortSessions(worktree.sessions).map((session) => (
        <SessionRow key={session.sessionId} session={session} selected={session.sessionId === selectedSessionId} onSelect={() => onSelectSession(session)} />
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
  onCode,
}: {
  project: Project
  collapsed: boolean
  onToggle: () => void
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  onCode: (target: CodeTarget) => void
}) {
  if (project.missing) {
    return (
      <section className="space-y-1 opacity-50">
        <div className="flex items-center justify-between px-3">
          <h2 className="truncate text-[13px] font-semibold text-ink-400">{project.name}</h2>
          <span className="text-[11.5px] text-ink-500">folder missing</span>
        </div>
      </section>
    )
  }
  const rows = projectWorktreeRows(project)
  return (
    <section className="space-y-1">
      <div className="group flex items-center justify-between px-3">
        <button type="button" onClick={onToggle} className="flex min-w-0 items-center gap-1.5 text-left">
          <span className="text-ink-500">{collapsed ? '›' : '▾'}</span>
          <h2 className="truncate text-[11.5px] font-semibold tracking-[0.07em] text-ink-500 uppercase">{project.name}</h2>
        </button>
        <CodeButton onClick={() => onCode({ root: project.path, title: project.name })} />
      </div>
      {!collapsed && rows.map(({ worktree, depth }) => (
        <WorktreeRow key={worktree.path} worktree={worktree} depth={depth} selectedSessionId={selectedSessionId} onSelectSession={onSelectSession} onCode={onCode} />
      ))}
    </section>
  )
}

// Every project the person works on, main checkout first with its worktrees and their stacks
// (see stack-model.ts), and the agent sessions running in each.
export function Sidebar({
  status,
  projects,
  selectedSessionId,
  onSelectSession,
  onCode,
  onImport,
}: {
  status: Status | null
  projects: Project[]
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  onCode: (target: CodeTarget) => void
  onImport: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const toggle = (name: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      writeCollapsed(next)
      return next
    })
  }
  return (
    <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Projects">
      <div className="flex items-center justify-between px-3">
        <h3 className="text-[11px] font-semibold tracking-[0.08em] text-ink-500 uppercase">Projects</h3>
        <button type="button" onClick={onImport} aria-label="Import project" className="rounded-full px-2 py-0.5 text-[15px] font-semibold text-ink-400 hover:bg-white/[0.08] hover:text-ink-200">
          +
        </button>
      </div>
      {status === null && projects.length === 0 && (
        <div className="px-3 py-2">
          <Spinner />
        </div>
      )}
      {projects.map((project) => (
        <ProjectSection
          key={project.name}
          project={project}
          collapsed={collapsed.has(project.name)}
          onToggle={() => toggle(project.name)}
          selectedSessionId={selectedSessionId}
          onSelectSession={onSelectSession}
          onCode={onCode}
        />
      ))}
      {projects.length === 0 && status !== null && <p className="px-3 text-[13px] text-ink-500">No projects yet.</p>}
    </nav>
  )
}
