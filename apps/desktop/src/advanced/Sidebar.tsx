import { useState } from 'react'
import type { Project, ProjectSession, ProjectWorktree, Status } from '@/api/schema'
import { projectWorktreeRows, relativeAge, sortSessions } from '@/advanced/projects-model'
import { AgentBadge } from '@/advanced/parts'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { PlusIcon } from '@/advanced/chrome'
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
  CLOSED: 'bg-white/10 text-ink-300',
}

function PullRequestBadge({ pullRequest }: { pullRequest: ProjectWorktree['pullRequest'] }) {
  if (pullRequest === null) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-ink-400">
      #{pullRequest.number}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${prChipClasses[pullRequest.state] ?? 'bg-white/10 text-ink-300'}`}>{pullRequest.state}</span>
    </span>
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

function CodeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-300 opacity-0 group-hover:opacity-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:opacity-100"
    >
      Code
    </button>
  )
}

const sessionDot: Record<ProjectSession['status'], string> = {
  working: 'bg-ok shadow-[0_0_8px_#34d399] animate-pulse',
  waiting: 'bg-warn',
  idle: 'bg-ink-400',
  ended: 'bg-ink-600',
}

const live = (session: ProjectSession) => session.status !== 'ended'

function SessionRow({ session, selected, onSelect }: { session: ProjectSession; selected: boolean; onSelect: () => void }) {
  const age = relativeAge(session.lastActivityAt)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      title={`${session.title} · ${session.agent} · ${session.status}`}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-[12px] py-1.5 pr-2.5 pl-[30px] text-left text-[13px] transition-colors ${
        selected ? 'bg-accent/[0.18] text-ink-100' : live(session) ? 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-100' : 'text-ink-400 hover:bg-white/[0.06] hover:text-ink-200'
      }`}
    >
      <AgentBadge agent={session.agent} size="sm" />
      <span className="truncate">{session.title}</span>
      <span className="text-[11.5px] text-ink-400 tabular-nums">{age}</span>
      <span className={`size-1.5 shrink-0 rounded-full ${sessionDot[session.status]}`} aria-label={session.status} />
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
  const running = worktree.sessions.some(live)
  const name = worktree.branch === null ? `Detached HEAD at ${worktree.head ?? ''}` : worktree.branch
  return (
    <div style={{ paddingLeft: `${depth * 14}px` }} className="space-y-0.5">
      <div className="group flex min-h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 hover:bg-white/[0.04]">
        <span className={`shrink-0 ${running ? 'text-ink-300' : 'text-ink-400'}`}>
          <BranchIcon />
        </span>
        <span title={worktree.path} className={`min-w-0 truncate text-[14px] ${running ? 'font-medium text-ink-100' : 'text-ink-400'}`}>
          {name}
        </span>
        {worktree.primary && <span className="shrink-0 rounded-[7px] border border-white/[0.16] px-1.5 text-[11px] leading-[18px] text-ink-300">primary</span>}
        <PullRequestBadge pullRequest={worktree.pullRequest} />
        <span className="ml-auto" />
        <CodeButton label={`Browse ${name}`} onClick={() => onCode({ root: worktree.path, title: folder(worktree.path) })} />
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
      <section className="flex items-center gap-2.5 px-2.5" title={project.path}>
        <ProjectPicture project={project} />
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink-400">{project.name}</h2>
        <span className="ml-auto shrink-0 text-[11.5px] text-ink-400">folder missing</span>
      </section>
    )
  }
  const rows = projectWorktreeRows(project)
  const running = project.worktrees.reduce((count, worktree) => count + worktree.sessions.filter(live).length, 0)
  return (
    <section className="space-y-1">
      <div className="group flex items-center gap-1 rounded-[14px] pr-1.5 hover:bg-white/[0.04]">
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} title={project.path} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 text-left">
          <ProjectPicture project={project} />
          <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{project.name}</h2>
          <span className="shrink-0 text-ink-400 opacity-0 group-hover:opacity-100">
            <Chevron open={!collapsed} />
          </span>
          {collapsed && running > 0 && <span className="ml-auto shrink-0 rounded-full bg-ok/[0.14] px-2 text-[11.5px] leading-5 font-semibold text-ok">{running}</span>}
        </button>
        <CodeButton label={`Browse ${project.name}`} onClick={() => onCode({ root: project.path, title: project.name })} />
      </div>
      {!collapsed && (
        <div className="space-y-1.5 pl-2">
          {rows.map(({ worktree, depth }) => (
            <WorktreeRow key={worktree.path} worktree={worktree} depth={depth} selectedSessionId={selectedSessionId} onSelectSession={onSelectSession} onCode={onCode} />
          ))}
        </div>
      )}
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
    <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-2.5 pt-1 pb-6" aria-label="Projects">
      <div className="flex items-center justify-between pr-1.5 pl-2.5">
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">Projects</h3>
        <button type="button" onClick={onImport} aria-label="Import project" title="Import project" className="flex size-7 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100">
          <PlusIcon />
        </button>
      </div>
      {status === null && projects.length === 0 && (
        <div className="px-2.5 py-2">
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
      {projects.length === 0 && status !== null && (
        <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
          <p className="text-[13.5px] text-ink-300">No projects yet.</p>
          <button type="button" onClick={onImport} className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
            Import a project
          </button>
        </div>
      )}
    </nav>
  )
}
