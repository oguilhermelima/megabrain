import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubIssue, GithubPullRequest, Project } from '@/api/schema'
import { DetailSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { emptyPullRequestFilters, filterPullRequests, githubRepository, includesAuthor, nextPage, otherPeople, pullRequestFilterOptions, refreshedPage, type GithubPage as Page, type PullRequestFilters, type PullRequestTab } from '@/github/github-model'
import { CloseIcon, CommentIcon, MaximiseIcon, MilestoneIcon, RefreshIcon } from '@/github/icons'
import { issuePage, pullRequestPage, type IssueState, type PullRequestState } from '@/github/github-requests'
import { Avatar, ChecksList, ConversationThread, OpenLink, IssueStateIcon, LabelChip, LineCounts, PullRequestStateIcon, ReviewChip, SkeletonRows, StatePill, ago, useNow } from '@/github/parts'
import { BranchFlow, StatPill } from '@/github/ItemHero'
import { ActionsPage } from '@/github/ActionsPage'
import { Empty, FilterSelect, IconButton, KindSwitch, LoadMore, Meta, OwnerPicture, SearchBox, Tabs, anyValue, dot, fromAny, people, pillButton, rowClass, splitDetail, splitList } from '@/github/page-parts'
import type { GithubKind, GithubPageKind } from '@/github/useGithubCounts'
import { reuse } from '@/lib/reuse'
import { pageMx, pageX } from '@/lib/page'

// A repository's pull requests, read through `megabrain github … --json` (its issues are the Tasks
// page's, which lists them with this page's listing, rows and detail pane): tabs with every
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

/** One tab's listing, a page at a time; switching tab or repository starts over from its first page. The Tasks page lists issues with it too. */
export function useListing(root: string, request: ListRequest) {
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


function PullRequestRow({ item, selected, now, onSelect }: { item: GithubPullRequest; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={rowClass(selected)}>
      <span className="pt-0.5">
        <PullRequestStateIcon item={item} />
      </span>
      <span className="min-w-0 space-y-2">
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
          <span className="min-w-0">
            <BranchFlow head={item.headRefName} base={item.baseRefName} />
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

export function IssueRow({ item, selected, now, onSelect }: { item: GithubIssue; selected: boolean; now: number; onSelect: () => void }) {
  // The meta line already names the author; an avatar on the right is only for someone else.
  const assignees = otherPeople(item.author?.login ?? null, item.assignees)
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} className={rowClass(selected)}>
      <span className="pt-0.5">
        <IssueStateIcon state={item.state} />
      </span>
      <span className="min-w-0 space-y-2">
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
        {assignees.length > 0 && (
          <span className="flex -space-x-1.5" title={`Assigned to ${assignees.map((assignee) => assignee.login).join(', ')}`}>
            {assignees.slice(0, 3).map((assignee) => (
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

/** One pull request or issue beside its list, read in full: the Tasks page shows an issue in it too. */
export function DetailPane({ project, kind, number, pullRequest, issue, onMaximise, onClose }: { project: Project; kind: 'prs' | 'issues'; number: number; pullRequest: GithubPullRequest | null; issue: GithubIssue | null; onMaximise: () => void; onClose: () => void }) {
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
  // The byline shows the author once; an author assigned to their own issue is said there, and only
  // other assignees get chips, under a label.
  const assignees = issue === null ? [] : otherPeople(author?.login ?? null, issue.assignees)
  const selfAssigned = issue !== null && includesAuthor(author?.login ?? null, issue.assignees)

  return (
    <aside className={splitDetail}>
      <header className={`space-y-3.5 ${pageX} pt-6 pb-5`}>
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
        <h2 className="text-[21px] leading-[1.3] font-semibold tracking-[-0.02em] text-balance text-ink-100 select-text">{title}</h2>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-ink-400">
          <span className="flex items-center gap-2">
            <Avatar login={author?.login ?? null} size={20} />
            <span className="font-semibold text-ink-200">{author?.login ?? 'ghost'}</span>
            <span>
              opened {ago(pullRequest?.createdAt ?? issue?.createdAt ?? detail?.createdAt ?? null, now)}
              {selfAssigned && ', assigned to themselves'}
            </span>
          </span>
          {pullRequest !== null && (
            <>
              {dot}
              <BranchFlow head={pullRequest.headRefName} base={pullRequest.baseRefName} />
            </>
          )}
        </div>
        {pullRequest !== null && detail?.additions !== undefined && detail.deletions !== undefined && (
          <div className="flex flex-wrap items-center gap-2">
            <StatPill>
              <LineCounts additions={detail.additions} deletions={detail.deletions} />
            </StatPill>
          </div>
        )}
        {(labels.length > 0 || review !== null || (issue !== null && (assignees.length > 0 || issue.milestone !== null))) && (
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
            {assignees.length > 0 && <span className="ml-1 text-[11.5px] text-ink-500">{assignees.length === 1 ? 'Assignee' : 'Assignees'}</span>}
            {assignees.map((assignee) => (
              <span key={assignee.login} className="inline-flex h-[20px] items-center gap-1 rounded-full bg-white/[0.07] pr-2 pl-0.5 text-[11.5px] font-semibold text-ink-300">
                <Avatar login={assignee.login} size={16} />
                {assignee.login}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto ${pageX} pb-8`}>
        {detail?.checks !== undefined && <ChecksList checks={detail.checks} />}
        {error !== null && <ErrorNote error={error} />}
        {detail === null && error === null && (
          <DetailSkeleton />
        )}
        {detail !== null && <ConversationThread detail={detail} now={now} bylineShown />}
      </div>
    </aside>
  )
}

type PageProps = { project: Project; focus: number | null; onKind: (kind: GithubKind) => void; onClose: () => void; onMaximise: (kind: 'pr' | 'issue' | 'run', number: number) => void }

/** A repository's pull requests or Actions runs; the kind switch in the header moves between them, and to the Tasks page for issues. */
export function GithubPage({ kind, ...props }: PageProps & { kind: GithubPageKind }) {
  if (kind === 'actions') return <ActionsPage project={props.project} focus={props.focus} onKind={props.onKind} onClose={props.onClose} onMaximise={(number) => props.onMaximise('run', number)} />
  return <ListPage {...props} />
}

function ListPage({ project, focus, onKind, onClose, onMaximise }: PageProps) {
  const repository = githubRepository(project.remote)
  const now = useNow(30_000)
  const [tab, setTab] = useState<PullRequestTab>('open')
  const [filters, setFilters] = useState<PullRequestFilters>(emptyPullRequestFilters)
  // Opened on one pull request (a worktree row's number): its detail shows at once, whichever tab lists it.
  const [selected, setSelected] = useState<number | null>(focus)
  const { listing, error, loading, loadingMore, reload, more } = useListing(project.path, { kind: 'prs', state: tab })

  const prs = useMemo(() => (listing?.kind === 'prs' ? listing.page.items : []), [listing])
  const shown = useMemo(() => filterPullRequests(prs, filters, tab), [prs, filters, tab])
  const options = useMemo(() => pullRequestFilterOptions(prs), [prs])
  // Every state's total travels with each page, so the tabs keep their counts while another tab loads.
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    if (listing !== null) setCounts(listing.page.counts)
  }, [listing])
  useEffect(() => setCounts(null), [project.path])
  const filtered = JSON.stringify(filters) !== JSON.stringify(emptyPullRequestFilters)
  const clearFilters = () => setFilters(emptyPullRequestFilters)
  const selectedPr = prs.find((item) => item.number === selected) ?? null
  const known = listing !== null
  const counted = (state: string) => counts?.[state] ?? null
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
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageX} pt-12`}>
        <Empty title={`${project.name} has no GitHub remote`} detail="Pull requests are read from the repository's github.com origin." action={<button type="button" onClick={onClose} className={pillButton}>Back</button>} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={`flex items-center gap-4 ${pageX} pt-6 pb-4`}>
        <OwnerPicture owner={repository.owner} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-semibold tracking-[-0.02em] text-ink-100">Pull requests</h1>
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
        <KindSwitch kind="prs" onKind={onKind} />
        <IconButton label="Refresh" onClick={() => void reload()} spinning={loading && known}>
          <RefreshIcon size={15} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={14} />
        </IconButton>
      </header>
      <div className={`flex flex-wrap items-center gap-2 ${pageX} pb-4`}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: 'Open', count: counted('open') },
            { value: 'merged', label: 'Merged', count: counted('merged') },
            { value: 'closed', label: 'Closed', count: counted('closed') },
            { value: 'all', label: 'All', count: counted('all') },
          ]}
        />
        <SearchBox value={filters.query} placeholder="Search title, number, branch, author, label" onChange={(query) => setFilters({ ...filters, query })} />
        <FilterSelect label="Author" value={filters.author ?? anyValue} options={people('Any author', options.authors)} onChange={(value) => setFilters({ ...filters, author: fromAny(value) })} />
        <FilterSelect label="Label" value={filters.label ?? anyValue} options={people('Any label', options.labels)} onChange={(value) => setFilters({ ...filters, label: fromAny(value) })} />
        <FilterSelect
          label="Draft"
          value={filters.draft}
          options={[
            { value: 'any', label: 'Drafts and ready' },
            { value: 'ready', label: 'Ready for review' },
            { value: 'draft', label: 'Drafts only' },
          ]}
          onChange={(draft) => setFilters({ ...filters, draft })}
        />
        {filtered && (
          <button type="button" onClick={clearFilters} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
            Clear
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-white/[0.06]">
        <div className={splitList(selected !== null)}>
          {!known && loading && <SkeletonRows />}
          {!known && !loading && error !== null && (
            <div className={`space-y-3 ${pageX} py-4`}>
              <ErrorNote error={error} />
              <button type="button" onClick={() => void reload()} className={pillButton}>
                Try again
              </button>
            </div>
          )}
          {known && error !== null && (
            <div className={`${pageX} pb-2`}>
              <ErrorNote error={error} />
            </div>
          )}
          {known && shown.length === 0 && !hasMore &&
            (filtered ? (
              <Empty title={`No ${tab === 'all' ? '' : `${tab} `}pull requests match`} detail="Try other words or clear the filters." action={<button type="button" onClick={clearFilters} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title={`No ${tab === 'all' ? '' : `${tab} `}pull requests`} detail={`${repository.nameWithOwner} has none right now.`} />
            ))}
          {known && (
            <ul className={`${pageMx} divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60`}>
              {shown.map((item) => (
                <li key={item.number}>
                  <PullRequestRow item={item} selected={item.number === selected} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                </li>
              ))}
            </ul>
          )}
          {known && hasMore && <LoadMore onVisible={more} loading={loadingMore} loaded={loadedCount} total={counted(tab)} />}
        </div>
        {selected !== null && <DetailPane key={selected} project={project} kind="prs" number={selected} pullRequest={selectedPr} issue={null} onMaximise={() => onMaximise('pr', selected)} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}
