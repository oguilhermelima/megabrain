import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubIssue, GithubPullRequest, Project } from '@/api/schema'
import { DetailSkeleton } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import {
  emptyIssueFilters,
  emptyPullRequestFilters,
  filterIssues,
  filterPullRequests,
  githubRepository,
  issueFilterOptions,
  nextPage,
  pullRequestFilterOptions,
  refreshedPage,
  type GithubPage as Page,
  type IssueFilters,
  type IssueTab,
  type PullRequestFilters,
  type PullRequestTab,
} from '@/github/github-model'
import { CloseIcon, CommentIcon, IssueIcon, MaximiseIcon, MilestoneIcon, PullRequestIcon, RefreshIcon } from '@/github/icons'
import { issuePage, pullRequestPage, type IssueState, type PullRequestState } from '@/github/github-requests'
import { Avatar, ChecksList, ConversationThread, OpenLink, IssueStateIcon, LabelChip, LineCounts, PullRequestStateIcon, ReviewChip, SkeletonRows, StatePill, ago, useNow } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'
import { reuse } from '@/lib/reuse'

// A repository's pull requests or issues, read through `megabrain github … --json`: tabs with every
// state's total, one light page of the tab at a time (the next one loads on scroll), search and
// filters over what is loaded, and a detail pane on the right with the body, comments and, for a
// pull request, its checks, review and line counts.

const refreshMs = 60_000

type Listing = { kind: 'prs'; page: Page<GithubPullRequest> } | { kind: 'issues'; page: Page<GithubIssue> }
type ListRequest = { kind: 'prs'; state: PullRequestState } | { kind: 'issues'; state: IssueState }

async function readPage(root: string, request: ListRequest, after: string | null): Promise<Listing> {
  if (request.kind === 'prs') return { kind: 'prs', page: await pullRequestPage(root, request.state, after) }
  return { kind: 'issues', page: await issuePage(root, request.state, after) }
}

/** A refresh puts the first page on top of what is loaded; more appends the next page below it. */
function joined(loaded: Listing | null, next: Listing, how: 'refresh' | 'more'): Listing {
  if (next.kind === 'prs') {
    const base = loaded?.kind === 'prs' ? loaded.page : null
    return { kind: 'prs', page: how === 'more' && base !== null ? nextPage(base, next.page) : refreshedPage(base, next.page) }
  }
  const base = loaded?.kind === 'issues' ? loaded.page : null
  return { kind: 'issues', page: how === 'more' && base !== null ? nextPage(base, next.page) : refreshedPage(base, next.page) }
}

/** One tab's listing, a page at a time; switching tab or repository starts over from its first page. */
function useListing(root: string, request: ListRequest) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const { kind, state } = request
  const key = `${root}\n${kind}\n${state}`
  const current = useRef(key)
  current.current = key
  const listed = useRef<Listing | null>(null)
  listed.current = listing

  const read = useCallback(
    async (how: 'refresh' | 'more') => {
      const after = how === 'more' ? (listed.current?.page.nextCursor ?? null) : null
      if (how === 'more' && after === null) return
      const setBusy = how === 'more' ? setLoadingMore : setLoading
      setBusy(true)
      try {
        const next = await readPage(root, { kind, state } as ListRequest, after)
        if (current.current !== key) return
        setListing((loaded) => reuse(loaded, joined(loaded, next, how)))
        setError(null)
      } catch (cause: unknown) {
        if (current.current === key) setError(cause)
      } finally {
        if (current.current === key) setBusy(false)
      }
    },
    [root, kind, state, key],
  )

  useEffect(() => {
    setListing(null)
    setError(null)
    setLoadingMore(false)
    void read('refresh')
    const timer = setInterval(() => void read('refresh'), refreshMs)
    return () => clearInterval(timer)
  }, [read])

  const more = useCallback(() => {
    if (!loadingMore) void read('more')
  }, [read, loadingMore])

  return { listing, error, loading, loadingMore, reload: () => read('refresh'), more }
}

/** Asks for the next page when the end of the list scrolls into view. */
function LoadMore({ onVisible, loading, loaded, total }: { onVisible: () => void; loading: boolean; loaded: number; total: number | null }) {
  const sentinel = useRef<HTMLDivElement>(null)
  const visible = useRef(onVisible)
  visible.current = onVisible
  useEffect(() => {
    const element = sentinel.current
    if (element === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) visible.current()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={sentinel} className="flex items-center gap-2 px-7 pt-3 text-[12px] text-ink-500">
      {loading && <Spinner />}
      <button type="button" onClick={onVisible} className="hover:text-ink-200">
        {loading ? 'Loading more…' : `Showing ${loaded}${total === null ? '' : ` of ${total}`}; load more`}
      </button>
    </div>
  )
}

function OwnerPicture({ owner }: { owner: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Avatar login={null} size={44} />
  return <img src={`https://github.com/${owner}.png?size=96`} alt="" draggable={false} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-[14px] bg-white/[0.06] object-cover" />
}

function IconButton({ label, onClick, children, spinning }: { label: string; onClick: () => void; children: ReactNode; spinning?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100">
      <span className={spinning === true ? 'animate-spin' : ''}>{children}</span>
    </button>
  )
}

function KindSwitch({ kind, onKind }: { kind: GithubKind; onKind: (kind: GithubKind) => void }) {
  const option = (value: GithubKind, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => onKind(value)}
      aria-pressed={kind === value}
      className={`flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${kind === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div className="inline-flex shrink-0 rounded-full border border-white/10 bg-white/[0.05] p-1">
      {option('prs', 'Pull requests', <PullRequestIcon size={14} />)}
      {option('issues', 'Issues', <IssueIcon size={14} />)}
    </div>
  )
}

function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; count: number | null }[]; onChange: (value: T) => void }) {
  return (
    <div role="tablist" className="inline-flex shrink-0 rounded-full border border-white/10 bg-white/[0.05] p-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={`flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${tab.value === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {tab.label}
          {tab.count !== null && <span className={`rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums ${tab.value === value ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.06] text-ink-400'}`}>{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

function SearchBox({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="flex h-9 min-w-[180px] flex-1 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.05] px-3.5 text-ink-400 focus-within:border-accent/60 focus-within:text-ink-200">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.4 10.4 3.1 3.1" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onChange('')
        }}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink-100 outline-none placeholder:text-ink-500"
      />
    </label>
  )
}

/** A filter as a pill: the native menu, so it is keyboard and screen-reader friendly for free. */
function FilterSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const active = value !== options[0]?.value
  return (
    <label className={`relative flex h-9 shrink-0 items-center rounded-full border text-[13px] font-semibold ${active ? 'border-accent/50 bg-accent/[0.16] text-ink-100' : 'border-white/[0.08] bg-white/[0.05] text-ink-300 hover:text-ink-100'}`}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} style={{ colorScheme: 'dark' }} className="h-full max-w-[200px] cursor-pointer appearance-none truncate rounded-full bg-transparent pr-8 pl-3.5 outline-none">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none absolute right-3">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </label>
  )
}

const anyValue = '\u0000any'
const people = (label: string, values: string[]) => [{ value: anyValue, label }, ...values.map((value) => ({ value, label: value }))]
const fromAny = (value: string) => (value === anyValue ? null : value)

function Empty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="mx-6 my-6 rounded-[24px] border border-dashed border-white/[0.12] px-6 py-10 text-center">
      <p className="text-[15px] font-semibold text-ink-200">{title}</p>
      {detail !== undefined && <p className="mt-1 text-[13.5px] text-ink-400">{detail}</p>}
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  )
}

const pillButton = 'rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]'

function Meta({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-400">{children}</span>
}

const dot = <span className="text-ink-600">·</span>

function rowClass(selected: boolean) {
  return `grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-[16px] px-4 py-3 text-left transition-colors ${selected ? 'bg-accent/[0.14]' : 'hover:bg-white/[0.04]'}`
}

function PullRequestRow({ item, selected, now, onSelect }: { item: GithubPullRequest; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={rowClass(selected)}>
      <span className="pt-0.5">
        <PullRequestStateIcon item={item} />
      </span>
      <span className="min-w-0 space-y-1.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14.5px] leading-snug font-semibold text-ink-100">{item.title}</span>
          {item.labels.map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
        </span>
        <Meta>
          <span className="shrink-0 tabular-nums">#{item.number}</span>
          {dot}
          <Avatar login={item.author?.login ?? null} size={16} />
          <span className="shrink-0">{item.author?.login ?? 'ghost'}</span>
          {dot}
          <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-300" title={`${item.headRefName} → ${item.baseRefName}`}>
            {item.headRefName} <span className="text-ink-500">→</span> {item.baseRefName}
          </span>
          {dot}
          <span className="shrink-0 whitespace-nowrap">{ago(item.updatedAt, now)}</span>
        </Meta>
      </span>
      <span className="flex items-center gap-3 pt-0.5 text-[12px] text-ink-400">
        <span className={`flex w-8 items-center gap-1 tabular-nums ${item.comments === 0 ? 'invisible' : ''}`}>
          <CommentIcon size={14} />
          {item.comments}
        </span>
      </span>
    </button>
  )
}

function IssueRow({ item, selected, now, onSelect }: { item: GithubIssue; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={rowClass(selected)}>
      <span className="pt-0.5">
        <IssueStateIcon state={item.state} />
      </span>
      <span className="min-w-0 space-y-1.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14.5px] leading-snug font-semibold text-ink-100">{item.title}</span>
          {item.labels.map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
        </span>
        <Meta>
          <span className="shrink-0 tabular-nums">#{item.number}</span>
          {dot}
          <Avatar login={item.author?.login ?? null} size={16} />
          <span className="shrink-0">{item.author?.login ?? 'ghost'}</span>
          {dot}
          <span className="shrink-0 whitespace-nowrap">{ago(item.updatedAt, now)}</span>
          {item.milestone !== null && (
            <>
              {dot}
              <span className="flex min-w-0 items-center gap-1 text-ink-300">
                <MilestoneIcon size={13} />
                <span className="truncate">{item.milestone.title}</span>
              </span>
            </>
          )}
        </Meta>
      </span>
      <span className="flex items-center gap-3 pt-0.5 text-[12px] text-ink-400">
        {item.assignees.length > 0 && (
          <span className="flex -space-x-1.5" title={`Assigned to ${item.assignees.map((assignee) => assignee.login).join(', ')}`}>
            {item.assignees.slice(0, 3).map((assignee) => (
              <span key={assignee.login} className="rounded-full ring-2 ring-ink-950">
                <Avatar login={assignee.login} size={20} />
              </span>
            ))}
          </span>
        )}
        <span className={`flex w-8 items-center gap-1 tabular-nums ${item.comments === 0 ? 'invisible' : ''}`}>
          <CommentIcon size={14} />
          {item.comments}
        </span>
      </span>
    </button>
  )
}

function DetailPane({ project, kind, number, pullRequest, issue, onMaximise, onClose }: { project: Project; kind: GithubKind; number: number; pullRequest: GithubPullRequest | null; issue: GithubIssue | null; onMaximise: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<GithubDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const now = useNow(60_000)

  useEffect(() => {
    let stopped = false
    setDetail(null)
    setError(null)
    const request = kind === 'prs' ? api.githubPullRequest(project.path, number) : api.githubIssue(project.path, number)
    request.then(
      (value) => !stopped && setDetail(value),
      (cause: unknown) => !stopped && setError(cause),
    )
    return () => {
      stopped = true
    }
  }, [project.path, kind, number])

  const title = pullRequest?.title ?? issue?.title ?? detail?.title ?? ''
  const url = pullRequest?.url ?? issue?.url ?? detail?.url ?? ''
  const author = pullRequest?.author ?? issue?.author ?? detail?.author ?? null
  const state = pullRequest?.state ?? issue?.state ?? detail?.state ?? 'open'
  const labels = pullRequest?.labels ?? issue?.labels ?? []
  const review = detail?.reviewDecision ?? null

  return (
    <aside className="flex min-h-0 w-[min(580px,50%)] shrink-0 flex-col border-l border-white/[0.06] bg-ink-950">
      <header className="space-y-3 px-6 pt-5 pb-4">
        <div className="flex items-center gap-2">
          <StatePill kind={kind === 'prs' ? 'pr' : 'issue'} state={state} draft={pullRequest?.isDraft ?? detail?.isDraft ?? false} />
          <span className="text-[13px] font-semibold text-ink-400 tabular-nums">#{number}</span>
          <span className="ml-auto" />
          {url !== '' && <OpenLink url={url} />}
          <IconButton label="Maximise" onClick={onMaximise}>
            <MaximiseIcon size={14} />
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
        <h2 className="text-[20px] leading-snug font-semibold tracking-[-0.01em] text-ink-100 select-text">{title}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-ink-400">
          <Avatar login={author?.login ?? null} size={18} />
          <span className="font-semibold text-ink-200">{author?.login ?? 'ghost'}</span>
          <span>opened {ago(pullRequest?.createdAt ?? issue?.createdAt ?? detail?.createdAt ?? null, now)}</span>
          {pullRequest !== null && (
            <>
              {dot}
              <span className="rounded-[7px] bg-white/[0.06] px-1.5 font-mono text-[11.5px] text-ink-200">{pullRequest.headRefName}</span>
              <span className="text-ink-500">→</span>
              <span className="rounded-[7px] bg-white/[0.06] px-1.5 font-mono text-[11.5px] text-ink-200">{pullRequest.baseRefName}</span>
              {detail?.additions !== undefined && detail.deletions !== undefined && (
                <>
                  {dot}
                  <LineCounts additions={detail.additions} deletions={detail.deletions} />
                </>
              )}
            </>
          )}
        </div>
        {(labels.length > 0 || review !== null || (issue !== null && (issue.assignees.length > 0 || issue.milestone !== null))) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ReviewChip decision={review} />
            {labels.map((label) => (
              <LabelChip key={label.name} name={label.name} color={label.color} />
            ))}
            {issue !== null && issue.milestone !== null && (
              <span className="inline-flex h-[20px] items-center gap-1 rounded-full bg-white/[0.07] px-2 text-[11.5px] font-semibold text-ink-300">
                <MilestoneIcon size={12} />
                {issue.milestone.title}
              </span>
            )}
            {issue?.assignees.map((assignee) => (
              <span key={assignee.login} className="inline-flex h-[20px] items-center gap-1 rounded-full bg-white/[0.07] pr-2 pl-0.5 text-[11.5px] font-semibold text-ink-300">
                <Avatar login={assignee.login} size={16} />
                {assignee.login}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-8">
        {detail?.checks !== undefined && <ChecksList checks={detail.checks} />}
        {error !== null && <ErrorNote error={error} />}
        {detail === null && error === null && (
          <DetailSkeleton />
        )}
        {detail !== null && <ConversationThread detail={detail} now={now} />}
      </div>
    </aside>
  )
}

export function GithubPage({ project, kind, focus, onKind, onClose, onMaximise }: { project: Project; kind: GithubKind; focus: number | null; onKind: (kind: GithubKind) => void; onClose: () => void; onMaximise: (kind: 'pr' | 'issue', number: number) => void }) {
  const repository = githubRepository(project.remote)
  const now = useNow(30_000)
  const [prTab, setPrTab] = useState<PullRequestTab>('open')
  const [issueTab, setIssueTab] = useState<IssueTab>('open')
  const [prFilters, setPrFilters] = useState<PullRequestFilters>(emptyPullRequestFilters)
  const [issueFilters, setIssueFilters] = useState<IssueFilters>(emptyIssueFilters)
  // Opened on one pull request (a worktree row's number): its detail shows at once, whichever tab lists it.
  const [selected, setSelected] = useState<number | null>(kind === 'prs' ? focus : null)
  const { listing, error, loading, loadingMore, reload, more } = useListing(project.path, kind === 'prs' ? { kind, state: prTab } : { kind, state: issueTab })

  const prs = useMemo(() => (listing?.kind === 'prs' ? listing.page.items : []), [listing])
  const issues = useMemo(() => (listing?.kind === 'issues' ? listing.page.items : []), [listing])
  const shownPrs = useMemo(() => filterPullRequests(prs, prFilters, prTab), [prs, prFilters, prTab])
  const shownIssues = useMemo(() => filterIssues(issues, issueFilters, issueTab), [issues, issueFilters, issueTab])
  const prOptions = useMemo(() => pullRequestFilterOptions(prs), [prs])
  const issueOptions = useMemo(() => issueFilterOptions(issues), [issues])
  // Every state's total travels with each page, so the tabs keep their counts while another tab loads.
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    if (listing !== null) setCounts(listing.page.counts)
  }, [listing])
  useEffect(() => setCounts(null), [project.path, kind])
  const filtered = kind === 'prs' ? JSON.stringify(prFilters) !== JSON.stringify(emptyPullRequestFilters) : JSON.stringify(issueFilters) !== JSON.stringify(emptyIssueFilters)
  const clearFilters = () => (kind === 'prs' ? setPrFilters(emptyPullRequestFilters) : setIssueFilters(emptyIssueFilters))
  const shownCount = kind === 'prs' ? shownPrs.length : shownIssues.length
  const selectedPr = kind === 'prs' ? (prs.find((item) => item.number === selected) ?? null) : null
  const selectedIssue = kind === 'issues' ? (issues.find((item) => item.number === selected) ?? null) : null
  const known = listing !== null
  const counted = (state: string) => counts?.[state] ?? null
  const noun = kind === 'prs' ? 'pull requests' : 'issues'
  const tabName = kind === 'prs' ? prTab : issueTab
  const loadedCount = listing?.page.items.length ?? 0
  const hasMore = (listing?.page.nextCursor ?? null) !== null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selected !== null && !(event.target instanceof HTMLInputElement)) setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  if (repository === null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-12">
        <Empty title={`${project.name} has no GitHub remote`} detail="Pull requests and issues are read from the repository's github.com origin." action={<button type="button" onClick={onClose} className={pillButton}>Back</button>} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-4 px-8 pt-6 pb-4">
        <OwnerPicture owner={repository.owner} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-semibold tracking-[-0.02em] text-ink-100">{kind === 'prs' ? 'Pull requests' : 'Issues'}</h1>
          <p className="flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-400">
            <span className="truncate">
              {repository.owner} / <span className="font-semibold text-ink-200">{repository.name}</span>
            </span>
            {listing !== null && (
              <>
                {dot}
                <span className="shrink-0">updated {ago(listing.page.fetchedAt, now)}</span>
              </>
            )}
          </p>
        </div>
        <KindSwitch kind={kind} onKind={onKind} />
        <IconButton label="Refresh" onClick={() => void reload()} spinning={loading && known}>
          <RefreshIcon size={15} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-8 pb-4">
        {kind === 'prs' ? (
          <Tabs
            value={prTab}
            onChange={setPrTab}
            tabs={[
              { value: 'open', label: 'Open', count: counted('open') },
              { value: 'merged', label: 'Merged', count: counted('merged') },
              { value: 'closed', label: 'Closed', count: counted('closed') },
              { value: 'all', label: 'All', count: counted('all') },
            ]}
          />
        ) : (
          <Tabs
            value={issueTab}
            onChange={setIssueTab}
            tabs={[
              { value: 'open', label: 'Open', count: counted('open') },
              { value: 'closed', label: 'Closed', count: counted('closed') },
              { value: 'all', label: 'All', count: counted('all') },
            ]}
          />
        )}
        {kind === 'prs' ? (
          <>
            <SearchBox value={prFilters.query} placeholder="Search title, number, branch, author, label" onChange={(query) => setPrFilters({ ...prFilters, query })} />
            <FilterSelect label="Author" value={prFilters.author ?? anyValue} options={people('Any author', prOptions.authors)} onChange={(value) => setPrFilters({ ...prFilters, author: fromAny(value) })} />
            <FilterSelect label="Label" value={prFilters.label ?? anyValue} options={people('Any label', prOptions.labels)} onChange={(value) => setPrFilters({ ...prFilters, label: fromAny(value) })} />
            <FilterSelect
              label="Draft"
              value={prFilters.draft}
              options={[
                { value: 'any', label: 'Drafts and ready' },
                { value: 'ready', label: 'Ready for review' },
                { value: 'draft', label: 'Drafts only' },
              ]}
              onChange={(draft) => setPrFilters({ ...prFilters, draft })}
            />
          </>
        ) : (
          <>
            <SearchBox value={issueFilters.query} placeholder="Search title, number, author, label, milestone" onChange={(query) => setIssueFilters({ ...issueFilters, query })} />
            <FilterSelect label="Author" value={issueFilters.author ?? anyValue} options={people('Any author', issueOptions.authors)} onChange={(value) => setIssueFilters({ ...issueFilters, author: fromAny(value) })} />
            <FilterSelect label="Label" value={issueFilters.label ?? anyValue} options={people('Any label', issueOptions.labels)} onChange={(value) => setIssueFilters({ ...issueFilters, label: fromAny(value) })} />
            <FilterSelect label="Assignee" value={issueFilters.assignee ?? anyValue} options={people('Any assignee', issueOptions.assignees)} onChange={(value) => setIssueFilters({ ...issueFilters, assignee: fromAny(value) })} />
          </>
        )}
        {filtered && (
          <button type="button" onClick={clearFilters} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
            Clear
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-white/[0.06]">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-3">
          {!known && loading && <SkeletonRows />}
          {!known && !loading && error !== null && (
            <div className="space-y-3 px-6 py-4">
              <ErrorNote error={error} />
              <button type="button" onClick={() => void reload()} className={pillButton}>
                Try again
              </button>
            </div>
          )}
          {known && error !== null && (
            <div className="px-6 pb-2">
              <ErrorNote error={error} />
            </div>
          )}
          {known && shownCount === 0 && !hasMore &&
            (filtered ? (
              <Empty title={`No ${tabName === 'all' ? '' : `${tabName} `}${noun} match`} detail="Try other words or clear the filters." action={<button type="button" onClick={clearFilters} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title={`No ${tabName === 'all' ? '' : `${tabName} `}${noun}`} detail={`${repository.nameWithOwner} has none right now.`} />
            ))}
          {known && (
            <ul className="space-y-0.5 px-3">
              {kind === 'prs'
                ? shownPrs.map((item) => (
                    <li key={item.number}>
                      <PullRequestRow item={item} selected={item.number === selected} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                    </li>
                  ))
                : shownIssues.map((item) => (
                    <li key={item.number}>
                      <IssueRow item={item} selected={item.number === selected} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                    </li>
                  ))}
            </ul>
          )}
          {known && hasMore && <LoadMore onVisible={more} loading={loadingMore} loaded={loadedCount} total={counted(tabName)} />}
        </div>
        {selected !== null && (
          <DetailPane key={`${kind}-${selected}`} project={project} kind={kind} number={selected} pullRequest={selectedPr} issue={selectedIssue} onMaximise={() => onMaximise(kind === 'prs' ? 'pr' : 'issue', selected)} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  )
}
