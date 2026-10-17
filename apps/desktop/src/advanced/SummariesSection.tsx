import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { Project, SummariesList, Summary, SummaryBranch } from '@/api/schema'
import { BranchIcon, Chevron } from '@/advanced/chrome'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor, projectInitials } from '@/advanced/picture-model'
import { relativeAge } from '@/advanced/projects-model'
import { HeaderButton, SearchField, SearchIcon } from '@/advanced/SidebarTools'
import { branchCount, branchLive, groupSummaries, summariesSectionKey, summaryProjectKey, summaryProjectOpen, type SummaryProject } from '@/advanced/summaries-model'
import { Collapse } from '@/components/Collapse'
import { ErrorNote } from '@/components/ui'
import { projectsPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'
import { parseChatSummaries } from '@/settings/summaries-model'

// The sidebar's Summaries section, above Projects: chat summaries by project and branch, the latest
// few of each branch. It reads on the projects cadence, folds into its header row, and its projects
// start folded (summaries-model.ts). With text in its search, the rows come from `summaries search`.

/** Summaries shown per branch; a full branch reads as "5+". */
const perBranch = 5

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
  const projects = useMemo<SummaryProject[] | null>(() => {
    if (text === '') return list?.projects ?? null
    return found?.query === text ? groupSummaries(found.results, branchLive(list), perBranch) : null
  }, [text, found, list])
  return { projects, enabled, error, loaded: list !== null || error !== null }
}

function SummaryRow({ summary, selected, now, onOpen }: { summary: Summary; selected: boolean; now: number; onOpen: (summary: Summary) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(summary)}
      aria-current={selected ? 'true' : undefined}
      title={`${summary.title}\n${new Date(summary.createdAt).toLocaleString()}`}
      className={`flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-[37px] text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <span className="min-w-0 flex-1 truncate">{summary.title}</span>
      <span className="w-[30px] shrink-0 text-right text-[11px] whitespace-nowrap text-ink-400 tabular-nums">{relativeAge(summary.createdAt, now)}</span>
    </button>
  )
}

function BranchRows({ branch, selectedId, now, onOpen }: { branch: SummaryBranch; selectedId: string | null; now: number; onOpen: (summary: Summary) => void }) {
  return (
    <div className="space-y-0.5">
      <div title={branch.live ? `${branch.branch}\n${branch.worktree}` : `${branch.branch}\nIts worktree is gone`} className={`flex h-8 items-center gap-2 pr-1.5 pl-[15px] ${branch.live ? 'text-ink-300' : 'text-ink-400 opacity-70'}`}>
        <span className="shrink-0">
          <BranchIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{branch.branch}</span>
        <span className="shrink-0 text-[11px] text-ink-400 tabular-nums" aria-label={`${branch.summaries.length} summaries`}>
          {branchCount(branch.summaries.length, perBranch)}
        </span>
      </div>
      {branch.summaries.map((summary) => (
        <SummaryRow key={summary.id} summary={summary} selected={summary.id === selectedId} now={now} onOpen={onOpen} />
      ))}
    </div>
  )
}

function ProjectRows({ project, listed, open, onToggle, selectedId, now, onOpen }: { project: SummaryProject; listed: Project | undefined; open: boolean; onToggle: () => void; selectedId: string | null; now: number; onOpen: (summary: Summary) => void }) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={`${project.project}\n${project.repo}`}
        className="group/fold flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 text-left transition-colors select-none hover:bg-row-hover"
      >
        <span className="relative flex shrink-0 items-center">
          <span className="transition-opacity duration-[120ms] group-hover/fold:opacity-0">
            <SummaryPicture project={listed} name={project.project} />
          </span>
          <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-ink-300 opacity-0 transition-opacity duration-[120ms] group-hover/fold:opacity-100">
            <Chevron open={open} />
          </span>
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{project.project}</h2>
      </button>
      <Collapse open={open}>
        <div className="space-y-1 pt-1">
          {project.branches.map((branch) => (
            <BranchRows key={branch.branch} branch={branch} selectedId={selectedId} now={now} onOpen={onOpen} />
          ))}
        </div>
      </Collapse>
    </section>
  )
}

export const SummariesSection = memo(function SummariesSection({
  projects,
  collapsed,
  onToggle,
  selectedId,
  onOpen,
  onOpenSettings,
  now,
  gutter,
}: {
  /** The listed projects, for their pictures. */
  projects: Project[]
  /** The sidebar state's fold keys: the section folds under its own key, a project opens under its. */
  collapsed: ReadonlySet<string>
  onToggle: (key: string) => void
  /** The summary whose page is in the focused pane, if any. */
  selectedId: string | null
  onOpen: (summary: Summary) => void
  /** Opens Settings on its Summaries page. */
  onOpenSettings: () => void
  now: number
  /** The list's scrollbar gutter, so the header ends where the Projects header does. */
  gutter: number
}) {
  const open = !collapsed.has(summariesSectionKey)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const { projects: grouped, enabled, error, loaded } = useSummaries(query)
  const listed = useMemo(() => new Map(projects.map((project) => [project.path, project])), [projects])
  const searching = query.trim() !== ''
  const empty = grouped !== null && grouped.length === 0

  return (
    <div className="flex max-h-[42%] shrink-0 flex-col border-b border-white/[0.07]">
      <div style={{ paddingRight: 4 + gutter }} className="shrink-0 space-y-2 py-2 pl-2.5">
        <div className="flex items-center justify-between pr-1.5 pl-2.5">
          <button type="button" onClick={() => onToggle(summariesSectionKey)} aria-expanded={open} title={open ? 'Fold the summaries' : 'Show the summaries'} className="flex items-center gap-1.5 text-ink-300 hover:text-ink-100">
            <h3 className="text-[13.5px] font-semibold tracking-[-0.01em]">Summaries</h3>
            <Chevron open={open} />
          </button>
          {open && (
            <span className="-mr-[9px] flex items-center gap-0.5">
              <HeaderButton
                label="Search summaries"
                on={searching}
                expanded={searchOpen}
                keepFocus
                onClick={() => {
                  if (searchOpen && query === '') return setSearchOpen(false)
                  setSearchOpen(true)
                  searchRef.current?.focus()
                }}
              >
                <SearchIcon />
              </HeaderButton>
            </span>
          )}
        </div>
        {open && searchOpen && <SearchField inputRef={searchRef} query={query} onQuery={setQuery} onClose={() => setSearchOpen(false)} placeholder="Search summaries" label="Search summaries" />}
      </div>
      {open && (
        <div style={{ scrollbarGutter: 'stable' }} className="sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 pb-2 pl-2.5">
          {enabled === false && (
            <p className="px-2.5 py-1 text-[12.5px] text-ink-400">
              Summaries are off.{' '}
              <button type="button" onClick={onOpenSettings} className="font-medium text-accent hover:underline">
                Turn them on in Settings
              </button>
            </p>
          )}
          {error !== null && grouped === null && (
            <div className="px-1">
              <ErrorNote error={error} />
            </div>
          )}
          {!loaded && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">Loading summaries…</p>}
          {empty && enabled !== false && <p className="px-2.5 py-1 text-[12.5px] text-ink-400">{searching ? 'No summary matches.' : 'No summaries yet.'}</p>}
          {grouped?.map((project) => (
            <ProjectRows
              key={project.repo}
              project={project}
              listed={listed.get(project.repo)}
              // A search opens every project it found; otherwise each stays as the person left it.
              open={searching || summaryProjectOpen(collapsed, project.repo)}
              onToggle={() => onToggle(summaryProjectKey(project.repo))}
              selectedId={selectedId}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  )
})
