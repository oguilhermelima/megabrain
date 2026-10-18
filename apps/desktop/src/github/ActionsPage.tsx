import { useEffect, useMemo, useState } from 'react'
import type { GithubActionRun, Project } from '@/api/schema'
import { defaultBranch } from '@/advanced/project-page-model'
import { ErrorNote } from '@/components/ui'
import { formatDuration, isLive, runDuration, runFilterOptions, runVisual, type GithubActionWorkflow } from '@/github/actions-model'
import { BranchChip, RunStatusIcon, eventName } from '@/github/actions-parts'
import { githubRepository } from '@/github/github-model'
import { ActionsIcon, CloseIcon, RefreshIcon } from '@/github/icons'
import { Empty, FilterSelect, IconButton, KindSwitch, LoadMore, OwnerPicture, SearchBox, anyValue, dot, fromAny, people, pillButton, rowClass, splitList } from '@/github/page-parts'
import { Avatar, SkeletonRows, ago, useNow } from '@/github/parts'
import { RunPane } from '@/github/RunDetail'
import { RunWorkflowDialog, type RunWorkflowRequest } from '@/github/RunWorkflowDialog'
import type { GithubKind } from '@/github/useGithubCounts'
import { useRuns } from '@/github/useRuns'
import { pageMx, pageX } from '@/lib/page'

// A repository's GitHub Actions in the pull request page's language: the workflows down the left
// (each one filters the runs, through the CLI), the runs a page at a time with a branch filter (also
// through the CLI) and a search and state filter over what is loaded, and the run's detail on the
// right. In-progress runs read again every 10 s while the window shows (useRuns). Run workflow
// starts a workflow that has a workflow_dispatch trigger.

const pageSize = 30

type StateFilter = 'any' | 'failure' | 'live' | 'success' | 'cancelled'

const stateOptions: { value: StateFilter; label: string }[] = [
  { value: 'any', label: 'Any state' },
  { value: 'failure', label: 'Failed' },
  { value: 'live', label: 'In progress or queued' },
  { value: 'success', label: 'Succeeded' },
  { value: 'cancelled', label: 'Cancelled or skipped' },
]

function shownState(run: GithubActionRun, filter: StateFilter): boolean {
  const visual = runVisual(run)
  if (filter === 'any') return true
  if (filter === 'live') return isLive(run)
  if (filter === 'cancelled') return visual === 'cancelled' || visual === 'skipped'
  return visual === filter
}

function matchesQuery(run: GithubActionRun, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  const text = [run.title, run.name, run.branch, run.actor, run.event, run.sha].join('\n').toLowerCase()
  return words.every((word) => word.replace(/^#/, '') === String(run.number) || text.includes(word))
}

function RunRow({ run, selected, now, onSelect }: { run: GithubActionRun; selected: boolean; now: number; onSelect: () => void }) {
  const duration = formatDuration(runDuration(run, now))
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={rowClass(selected)}>
      <span className="pt-0.5">
        <RunStatusIcon item={run} tip />
      </span>
      <span className="min-w-0 space-y-2">
        <span className="block text-[14.5px] leading-snug font-semibold text-ink-100">{run.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-400">
          <span className="shrink-0 font-semibold text-ink-300">{run.name}</span>
          <span className="shrink-0 tabular-nums">#{run.number}</span>
          {dot}
          <BranchChip branch={run.branch} className="max-w-[14rem]" />
          {dot}
          <span className="shrink-0">{eventName(run.event)}</span>
          {dot}
          <Avatar login={run.actor.replace(/\[bot\]$/, '')} size={16} />
          <span className="min-w-0 truncate">{run.actor}</span>
        </span>
      </span>
      <span className="flex flex-col items-end gap-1.5 pt-0.5 text-[12px] whitespace-nowrap text-ink-400 tabular-nums">
        <span className={isLive(run) ? 'text-warn' : ''}>{duration}</span>
        <span className="text-ink-500">{ago(run.createdAt, now)}</span>
      </span>
    </button>
  )
}

function WorkflowRail({ workflows, value, onChange }: { workflows: GithubActionWorkflow[]; value: string | null; onChange: (value: string | null) => void }) {
  const item = (id: string | null, label: string, muted: boolean, tag: string | null) => (
    <li key={id ?? 'all'}>
      <button
        type="button"
        onClick={() => onChange(id)}
        aria-current={value === id ? 'true' : undefined}
        className={`flex h-9 w-full min-w-0 items-center gap-2 rounded-[12px] px-3 text-left text-[13px] font-semibold transition-colors duration-[var(--motion-enter)] ${value === id ? 'bg-white/[0.10] text-ink-100' : muted ? 'text-ink-500 hover:bg-white/[0.04] hover:text-ink-300' : 'text-ink-300 hover:bg-white/[0.04] hover:text-ink-100'}`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {tag !== null && <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 text-[10.5px] leading-[16px] font-semibold text-ink-500">{tag}</span>}
      </button>
    </li>
  )
  return (
    <nav aria-label="Workflows" className="w-[220px] shrink-0 overflow-y-auto border-r border-white/[0.06] py-5 pr-3 pl-6">
      <h2 className="px-3 pb-2 text-[11.5px] font-semibold tracking-[0.04em] text-ink-500 uppercase">Workflows</h2>
      <ul className="space-y-0.5">
        {item(null, 'All workflows', false, null)}
        {workflows.map((workflow) => item(String(workflow.id), workflow.name, workflow.state !== 'active', workflow.state === 'active' ? null : 'Disabled'))}
      </ul>
    </nav>
  )
}

/** Opened on one run (`focus`, a run id from the project page), its detail shows at once. */
export function ActionsPage({ project, focus, onKind, onClose, onMaximise }: { project: Project; focus: number | null; onKind: (kind: GithubKind) => void; onClose: () => void; onMaximise: (runId: number) => void }) {
  const repository = githubRepository(project.remote)
  const [workflow, setWorkflow] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<StateFilter>('any')
  const [selected, setSelected] = useState<number | null>(focus)
  const [dispatch, setDispatch] = useState<RunWorkflowRequest | null>(null)
  const { page, error, loading, loadingMore, reload, more } = useRuns(repository === null ? null : project.path, { workflow, branch }, pageSize)
  // Durations of running runs tick each second; otherwise only the times ago need refreshing.
  const now = useNow(page !== null && page.runs.some(isLive) ? 1000 : 30_000)

  // The rail and the branch filter keep what they have seen, so filtering never empties them.
  const [workflows, setWorkflows] = useState<GithubActionWorkflow[]>([])
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    if (page === null) return
    setWorkflows(page.workflows)
    const seen = runFilterOptions(page.runs, page.workflows).branches
    setBranches((current) => (seen.every((name) => current.includes(name)) ? current : [...new Set([...current, ...seen])].sort((left, right) => left.localeCompare(right))))
  }, [page])

  const runs = useMemo(() => (page?.runs ?? []).filter((run) => shownState(run, state) && matchesQuery(run, query)), [page, state, query])
  const selectedRun = page?.runs.find((run) => run.id === selected) ?? null
  const filtered = query.trim() !== '' || state !== 'any' || branch !== null || workflow !== null
  const clear = () => {
    setQuery('')
    setState('any')
    setBranch(null)
    setWorkflow(null)
  }
  const dispatchable = workflows.filter((entry) => entry.dispatchable && entry.state === 'active')
  const picked = workflows.find((entry) => String(entry.id) === workflow) ?? null
  const runTarget = picked === null ? (dispatchable[0] ?? null) : dispatchable.includes(picked) ? picked : null
  const startDispatch = () => runTarget !== null && setDispatch({ workflows: picked === null ? dispatchable : [runTarget], workflow: runTarget, ref: branch ?? defaultBranch(project) ?? 'main', branches })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selected !== null && !(event.target instanceof HTMLInputElement)) setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  if (repository === null) {
    return (
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageX} pt-12`}>
        <Empty title={`${project.name} has no GitHub remote`} detail="Workflow runs are read from the repository's github.com origin." action={<button type="button" onClick={onClose} className={pillButton}>Back</button>} />
      </div>
    )
  }

  const known = page !== null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={`flex items-center gap-4 ${pageX} pt-6 pb-4`}>
        <OwnerPicture owner={repository.owner} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-semibold tracking-[-0.02em] text-ink-100">Actions</h1>
          <p className="flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-400">
            <span className="truncate">
              {repository.owner} / <span className="font-semibold text-ink-200">{repository.name}</span>
            </span>
            {page !== null && (
              <>
                {dot}
                <span className="shrink-0">updated {ago(page.fetchedAt, now)}</span>
              </>
            )}
          </p>
        </div>
        <KindSwitch kind="actions" onKind={onKind} />
        {runTarget !== null && (
          <button type="button" onClick={startDispatch} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:bg-[#a3aeff]">
            <ActionsIcon size={14} />
            Run workflow
          </button>
        )}
        <IconButton label="Refresh" onClick={reload} spinning={loading && known}>
          <RefreshIcon size={15} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${pageX} pb-4`}>
        <SearchBox value={query} placeholder="Search title, workflow, branch, actor, run number" onChange={setQuery} />
        <FilterSelect label="Branch" value={branch ?? anyValue} options={people('Any branch', branch === null || branches.includes(branch) ? branches : [branch, ...branches])} onChange={(value) => setBranch(fromAny(value))} />
        <FilterSelect label="State" value={state} options={stateOptions} onChange={setState} />
        {filtered && (
          <button type="button" onClick={clear} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
            Clear
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-white/[0.06]">
        {/* The run's detail takes the rail's room; the rail comes back when it closes. */}
        {selectedRun === null && <WorkflowRail workflows={workflows} value={workflow} onChange={setWorkflow} />}
        <div className={splitList(selectedRun !== null)}>
          {!known && loading && <SkeletonRows />}
          {!known && !loading && error !== null && (
            <div className={`space-y-3 ${pageX} py-4`}>
              <ErrorNote error={error} />
              <button type="button" onClick={reload} className={pillButton}>
                Try again
              </button>
            </div>
          )}
          {known && error !== null && (
            <div className={`${pageX} pb-2`}>
              <ErrorNote error={error} />
            </div>
          )}
          {known && runs.length === 0 && page.next === null &&
            (filtered ? (
              <Empty title="No runs match" detail="Try other words or clear the filters." action={<button type="button" onClick={clear} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title="No workflow runs" detail={`${repository.nameWithOwner} has not run any workflow yet.`} />
            ))}
          {known && runs.length > 0 && (
            <ul className={`${pageMx} divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60`}>
              {runs.map((run) => (
                <li key={run.id}>
                  <RunRow run={run} selected={run.id === selected} now={now} onSelect={() => setSelected(run.id === selected ? null : run.id)} />
                </li>
              ))}
            </ul>
          )}
          {known && page.next !== null && <LoadMore onVisible={() => void more()} loading={loadingMore} loaded={page.runs.length} total={null} />}
        </div>
        {selectedRun !== null && <RunPane key={selectedRun.id} root={project.path} run={selectedRun} onMaximise={() => onMaximise(selectedRun.id)} onClose={() => setSelected(null)} onChanged={reload} />}
      </div>
      <RunWorkflowDialog
        root={project.path}
        request={dispatch}
        onStarted={() => {
          setDispatch(null)
          reload()
        }}
        onClose={() => setDispatch(null)}
      />
    </div>
  )
}
