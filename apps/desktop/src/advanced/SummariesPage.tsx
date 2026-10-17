import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, SummariesList, Summary, SummaryBranch } from '@/api/schema'
import { BranchIcon, Chevron } from '@/advanced/chrome'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor, projectInitials } from '@/advanced/picture-model'
import { relativeAge } from '@/advanced/projects-model'
import { branchCount, branchLive, foldKey, groupSummaries, neighbours, newestSummary, summaryOfItem, type SummaryProject } from '@/advanced/summaries-model'
import { MarkdownText } from '@/chat/markdown'
import { AgentIcon } from '@/components/agent-icons'
import { Collapse } from '@/components/Collapse'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'
import { projectsPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'
import { parseChatSummaries } from '@/settings/summaries-model'

// The Summaries page, a wiki of chat summaries in one pane: a navigation column of projects, their
// branches and each branch's summaries, with a search over them, beside the picked summary in a
// reading column: where it was made, who wrote it and when, its text, and the newer and older
// summaries of its branch. The item's id is the summary shown (summaries-model.ts); with none
// picked the page shows the newest. With text in the search, the navigation comes from `summaries search`.

/** Summaries the navigation lists per branch; a full branch reads as "25+". */
const perBranch = 25

/** How far back the page looks for a summary's neighbours in its branch. */
const branchWindow = 100

/** A project's picture when megabrain lists it, else its initials on its colour. */
export function SummaryPicture({ project, name }: { project: Project | undefined; name: string }) {
  if (project !== undefined) return <ProjectPicture project={project} />
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-[10.5px] font-bold tracking-[0.02em] text-white">
      {projectInitials(name)}
    </span>
  )
}

function useSummaries(query: string) {
  const [list, setList] = useState<SummariesList | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState<unknown>(null)
  usePoll(
    projectsPolicy,
    async (current) => {
      try {
        const [saved, next] = await Promise.all([api.chatSummaries().catch(() => null), api.summaries({ limit: perBranch })])
        if (!current()) return
        setEnabled(saved === null ? null : parseChatSummaries(saved).enabled)
        setList(next)
        setError(null)
      } catch (caught) {
        // The last good list stays; usePoll tries again sooner.
        if (current()) setError(caught)
        throw caught
      }
    },
    [],
  )
  // A search waits for the typing to stop, and an answer to older text is dropped.
  const [found, setFound] = useState<{ query: string; results: Summary[] } | null>(null)
  const text = query.trim()
  useEffect(() => {
    if (text === '') return
    let current = true
    const timer = setTimeout(() => {
      api.searchSummaries(text, { limit: 50 }).then(
        (next) => current && setFound({ query: text, results: next.results }),
        (caught: unknown) => current && setError(caught),
      )
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [text])
  const results = found?.query === text ? found.results : null
  const shown = useMemo<SummaryProject[] | null>(() => {
    if (text === '') return list?.projects ?? null
    return results === null ? null : groupSummaries(results, branchLive(list), perBranch)
  }, [text, results, list])
  return { all: list?.projects ?? null, shown, enabled, error, loaded: list !== null || error !== null }
}

type Loaded = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; summary: Summary; branch: Summary[] }

function useSummary(id: string | null): Loaded {
  const [load, setLoad] = useState<{ id: string | null; value: Loaded }>({ id, value: { state: 'loading' } })
  useEffect(() => {
    if (id === null) return
    let current = true
    api
      .summary(id)
      .then(async (summary) => {
        // The neighbours are a convenience; a failed list still shows the summary.
        const list = await api.summaries({ repo: summary.repo, branch: summary.branch, limit: branchWindow }).catch(() => null)
        const branch = list?.projects.find((project) => project.repo === summary.repo)?.branches.find((entry) => entry.branch === summary.branch)?.summaries ?? []
        if (current) setLoad({ id, value: { state: 'ready', summary, branch } })
      })
      .catch((error: unknown) => {
        if (current) setLoad({ id, value: { state: 'failed', error } })
      })
    return () => {
      current = false
    }
  }, [id])
  return load.id === id ? load.value : { state: 'loading' }
}

function NavSummary({ summary, selected, now, onPick }: { summary: Summary; selected: boolean; now: number; onPick: (summary: Summary) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  // The picked summary stays in view, whether picked here, from a neighbour or restored.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(summary)}
      aria-current={selected ? 'page' : undefined}
      title={`${summary.title}\n${new Date(summary.createdAt).toLocaleString()}`}
      className={`flex h-8 w-full items-center gap-2 rounded-[10px] pr-2 pl-[30px] text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <span className="min-w-0 flex-1 truncate">{summary.title}</span>
      <span className="shrink-0 text-[11px] whitespace-nowrap text-ink-400 tabular-nums">{relativeAge(summary.createdAt, now)}</span>
    </button>
  )
}

function NavBranch({ repo, branch, open, onToggle, selectedId, now, onPick }: { repo: string; branch: SummaryBranch; open: boolean; onToggle: (key: string) => void; selectedId: string | null; now: number; onPick: (summary: Summary) => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(foldKey(repo, branch.branch))}
        aria-expanded={open}
        title={branch.live ? `${branch.branch}\n${branch.worktree}` : `${branch.branch}\nIts worktree is gone`}
        className={`group/fold flex h-8 w-full items-center gap-2 rounded-[10px] pr-2 pl-2.5 text-left transition-colors hover:bg-row-hover ${branch.live ? 'text-ink-300' : 'text-ink-400 opacity-70'}`}
      >
        <span className="relative grid size-3.5 shrink-0 place-items-center">
          <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
            <BranchIcon />
          </span>
          <span aria-hidden="true" className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
            <Chevron open={open} />
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">{branch.branch}</span>
        <span className="shrink-0 text-[11px] text-ink-400 tabular-nums" aria-label={`${branch.summaries.length} summaries`}>
          {branchCount(branch.summaries.length, perBranch)}
        </span>
      </button>
      <Collapse open={open}>
        <div className="space-y-0.5 pt-0.5 pb-1">
          {branch.summaries.map((summary) => (
            <NavSummary key={summary.id} summary={summary} selected={summary.id === selectedId} now={now} onPick={onPick} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

function NavProject({ project, listed, folded, searching, onToggle, selectedId, now, onPick }: { project: SummaryProject; listed: Project | undefined; folded: ReadonlySet<string>; searching: boolean; onToggle: (key: string) => void; selectedId: string | null; now: number; onPick: (summary: Summary) => void }) {
  // A search opens everything it found; otherwise each fold stays as the person left it.
  const open = (key: string) => searching || !folded.has(key)
  const projectOpen = open(foldKey(project.repo))
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(foldKey(project.repo))}
        aria-expanded={projectOpen}
        title={`${project.project}\n${project.repo}`}
        className="group/fold flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[12px] pr-2 pl-1.5 text-left transition-colors select-none hover:bg-row-hover"
      >
        <span className="relative flex shrink-0 items-center">
          <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
            <SummaryPicture project={listed} name={project.project} />
          </span>
          <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
            <Chevron open={projectOpen} />
          </span>
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink-100">{project.project}</h2>
      </button>
      <Collapse open={projectOpen}>
        <div className="space-y-0.5 pt-0.5 pb-2">
          {project.branches.map((branch) => (
            <NavBranch key={branch.branch} repo={project.repo} branch={branch} open={open(foldKey(project.repo, branch.branch))} onToggle={onToggle} selectedId={selectedId} now={now} onPick={onPick} />
          ))}
        </div>
      </Collapse>
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-200">{children}</dd>
    </div>
  )
}

function Neighbour({ summary, direction, onPick, now }: { summary: Summary | null; direction: 'newer' | 'older'; onPick: (summary: Summary) => void; now: number }) {
  const label = direction === 'newer' ? 'Newer' : 'Older'
  if (summary === null) return <div className="flex-1 rounded-[14px] border border-dashed border-white/[0.08] px-4 py-3 text-[12.5px] text-ink-500">{direction === 'newer' ? 'This is the latest summary' : 'This is the first summary kept'}</div>
  return (
    <button type="button" onClick={() => onPick(summary)} className={`min-w-0 flex-1 rounded-[14px] border border-white/[0.08] bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.07] ${direction === 'older' ? 'text-right' : 'text-left'}`}>
      <span className="block text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">
        {direction === 'newer' ? `← ${label}` : `${label} →`} · {relativeAge(summary.createdAt, now)}
      </span>
      <span className="mt-1 block truncate text-[13.5px] text-ink-100">{summary.title}</span>
    </button>
  )
}

/** The reading column's width: about 720px of text inside its padding. */
const column = 'mx-auto w-full max-w-[784px] px-8 py-10'

function Reading({ id, projects, chats, now, onPick, onOpenChat }: { id: string; projects: Project[]; chats: NativeChat[]; now: number; onPick: (summary: Summary) => void; onOpenChat: (chat: NativeChat) => void }) {
  const load = useSummary(id)
  if (load.state === 'loading') {
    return (
      <div className={column}>
        <TextSkeleton lines={6} />
      </div>
    )
  }
  if (load.state === 'failed') {
    return (
      <div className={column}>
        <ErrorNote error={load.error} />
      </div>
    )
  }
  const { summary, branch } = load
  const project = projects.find((entry) => entry.path === summary.repo)
  const chat = chats.find((entry) => entry.id === summary.chatId) ?? null
  const live = project?.worktrees.some((worktree) => worktree.path === summary.worktree) ?? false
  const { newer, older } = neighbours(branch, summary.id)
  return (
    <div className={`${column} space-y-8`}>
      <header className="space-y-5">
        <div className="flex items-center gap-2.5 text-[13px] text-ink-300">
          <SummaryPicture project={project} name={summary.project} />
          <span className="font-semibold text-ink-200">{summary.project}</span>
          <span className="text-ink-500">/</span>
          <span className={`flex min-w-0 items-center gap-1.5 ${live ? '' : 'opacity-70'}`} title={live ? summary.worktree : `${summary.worktree}\nIts worktree is gone`}>
            <BranchIcon />
            <span className="truncate">{summary.branch}</span>
          </span>
        </div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{summary.title}</h1>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-[18px] border border-white/[0.07] bg-white/[0.02] px-5 py-4 sm:grid-cols-3">
          <Fact label="Chat">
            <AgentIcon agent={summary.agent} className="shrink-0 text-ink-300" />
            {chat === null ? (
              <span className="truncate text-ink-400" title="The chat is no longer listed">
                {summary.chatId}
              </span>
            ) : (
              <button type="button" onClick={() => onOpenChat(chat)} className="truncate font-medium text-accent hover:underline">
                {chat.title ?? 'Open the chat'}
              </button>
            )}
          </Fact>
          <Fact label="Written by">
            <span className="truncate">{summary.model}</span>
          </Fact>
          <Fact label="When">
            <span title={summary.createdAt}>
              {new Date(summary.createdAt).toLocaleString()} · {relativeAge(summary.createdAt, now)}
            </span>
          </Fact>
        </dl>
      </header>
      <MarkdownText text={summary.text} className="text-[14.5px] leading-relaxed text-ink-200" />
      <nav aria-label={`Other summaries of ${summary.branch}`} className="flex gap-3 border-t border-white/[0.07] pt-6">
        <Neighbour summary={newer} direction="newer" onPick={onPick} now={now} />
        <Neighbour summary={older} direction="older" onPick={onPick} now={now} />
      </nav>
    </div>
  )
}

/** The reading column with nothing to read: why, and what to do about it. */
function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`${column} pt-24 text-center`}>
      <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
      <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-ink-400">{children}</p>
    </div>
  )
}

export function SummariesPage({
  id,
  projects,
  chats,
  onPick,
  onOpenChat,
  onOpenSettings,
}: {
  /** The item's id: the summary shown, or the latest page (summaries-model.ts). */
  id: string
  /** The listed projects, for their pictures and whether a worktree still exists. */
  projects: Project[]
  chats: NativeChat[]
  /** Shows a summary on this page. */
  onPick: (summary: Summary) => void
  onOpenChat: (chat: NativeChat) => void
  /** Opens Settings on its Summaries page. */
  onOpenSettings: () => void
}) {
  const now = useNow(30_000)
  const [query, setQuery] = useState('')
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const { all, shown, enabled, error, loaded } = useSummaries(query)
  const listed = useMemo(() => new Map(projects.map((project) => [project.path, project])), [projects])
  const searching = query.trim() !== ''
  const selectedId = summaryOfItem(id) ?? newestSummary(all)?.id ?? null
  const none = all !== null && all.length === 0
  const off = enabled === false

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Summaries" className="flex w-[272px] shrink-0 flex-col border-r border-white/[0.07]">
        <div className="shrink-0 px-3 pt-3 pb-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || query === '') return
              event.preventDefault()
              setQuery('')
            }}
            placeholder="Search summaries"
            aria-label="Search summaries"
            className="h-8 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-[13px] text-ink-100 placeholder:text-ink-400 focus:border-accent/60 focus:outline-none"
          />
        </div>
        <div style={{ scrollbarGutter: 'stable' }} className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 pb-3 pl-2">
          {off && !none && (
            <p className="px-2 py-1 text-[12.5px] text-ink-400">
              Summaries are off.{' '}
              <button type="button" onClick={onOpenSettings} className="font-medium text-accent hover:underline">
                Turn them on in Settings
              </button>
            </p>
          )}
          {error !== null && shown === null && (
            <div className="px-1">
              <ErrorNote error={error} />
            </div>
          )}
          {!loaded && <p className="px-2 py-1 text-[12.5px] text-ink-400">Loading summaries…</p>}
          {searching && shown?.length === 0 && <p className="px-2 py-1 text-[12.5px] text-ink-400">No summary matches “{query.trim()}”.</p>}
          {shown?.map((project) => (
            <NavProject key={project.repo} project={project} listed={listed.get(project.repo)} folded={folded} searching={searching} onToggle={toggle} selectedId={selectedId} now={now} onPick={onPick} />
          ))}
        </div>
      </nav>
      <article className="min-w-0 flex-1 overflow-y-auto">
        {selectedId !== null ? (
          <Reading key={selectedId} id={selectedId} projects={projects} chats={chats} now={now} onPick={onPick} onOpenChat={onOpenChat} />
        ) : none && off ? (
          <Blank title="Summaries are off">
            Chats are not being summarised.{' '}
            <button type="button" onClick={onOpenSettings} className="font-medium text-accent hover:underline">
              Turn them on in Settings
            </button>{' '}
            and each chat's work is written up here, by project and branch.
          </Blank>
        ) : none ? (
          <Blank title="No summaries yet">As chats work, megabrain writes up what each one did. They gather here by project and branch.</Blank>
        ) : (
          error === null && (
            <div className={column}>
              <TextSkeleton lines={6} />
            </div>
          )
        )}
      </article>
    </div>
  )
}
