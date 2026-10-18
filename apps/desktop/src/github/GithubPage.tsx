import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubIssue, GithubIssueList, GithubPullRequest, GithubPullRequestList, Project } from '@/api/schema'
import { DetailSkeleton } from '@/components/Skeleton'
import type { SheetField } from '@/components/filter-sheet-model'
import { FilterButton, FilterChips, FilterSheet } from '@/components/FilterSheet'
import { ErrorNote } from '@/components/ui'
import { emptyPullRequestFilters, githubRepository, includesAuthor, otherPeople, type IssueFilters, type PullRequestFilters, type PullRequestTab } from '@/github/github-model'
import { firstCursors, withNext } from '@/github/pager'
import { CloseIcon, CommentIcon, MaximiseIcon, MilestoneIcon, RefreshIcon } from '@/github/icons'
import { issuePage, pullRequestPage, type IssueState, type PullRequestState } from '@/github/github-requests'
import { Avatar, ChecksList, ConversationThread, OpenLink, IssueStateIcon, LabelChip, LineCounts, PullRequestStateIcon, ReviewChip, SkeletonRows, StatePill, ago, useNow } from '@/github/parts'
import { BranchFlow, StatPill } from '@/github/ItemHero'
import { ActionsPage } from '@/github/ActionsPage'
import { Empty, IconButton, KindSwitch, Meta, OwnerPicture, Pager, SearchBox, Tabs, anyValue, dot, fromAny, people, pillButton, rowClass, splitDetail, splitList, useSettled } from '@/github/page-parts'
import type { GithubKind, GithubPageKind } from '@/github/useGithubCounts'
import { reuse } from '@/lib/reuse'
import { pageDivider, pageMx, pageX } from '@/lib/page'

// A repository's pull requests, read through `megabrain github … --json` (its issues are the Tasks
// page's, which lists them with this page's listing, rows and detail pane): tabs with every
// state's total, the tab a page at a time under a pager, search and filters GitHub applies to the
// whole repository, and a detail pane on the right with the body, comments and, for a
// pull request, its checks, review and line counts.

const refreshMs = 60_000

type Listing = { kind: 'prs'; page: GithubPullRequestList } | { kind: 'issues'; page: GithubIssueList }
type ListRequest = { kind: 'prs'; state: PullRequestState; filters: PullRequestFilters } | { kind: 'issues'; state: IssueState; filters: IssueFilters }

async function readPage(root: string, request: ListRequest, after: string | null): Promise<Listing> {
  if (request.kind === 'prs') return { kind: 'prs', page: await pullRequestPage(root, request.state, after, request.filters) }
  return { kind: 'issues', page: await issuePage(root, request.state, after, request.filters) }
}

/**
 * One tab's listing a page at a time (github/pager): the page shown, the cursors that reach the pages
 * before and after it, and every state's total. Another repository, tab or filter starts again from the
 * first page; the shown page is read again every minute. The Tasks page lists issues with it too.
 */
export function usePagedListing(root: string, request: ListRequest) {
  const key = JSON.stringify([root, request])
  const [at, setAt] = useState({ key, index: 0, cursors: firstCursors })
  const place = at.key === key ? at : { key, index: 0, cursors: firstCursors }
  if (place !== at) setAt(place)
  const [shown, setShown] = useState<{ key: string; index: number; listing: Listing } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const { index } = place
  const cursor = place.cursors[index] ?? null
  const asked = useRef(request)
  asked.current = request
  const current = useRef('')
  current.current = `${key}\n${index}`

  const read = useCallback(async () => {
    const reading = `${key}\n${index}`
    setLoading(true)
    try {
      const listing = await readPage(root, asked.current, cursor)
      if (current.current !== reading) return
      setShown((loaded) => reuse(loaded, { key, index, listing }))
      setAt((now) => (now.key === key ? { ...now, cursors: withNext(now.cursors, index, listing.page.nextCursor) } : now))
      setError(null)
    } catch (cause: unknown) {
      if (current.current === reading) setError(cause)
    } finally {
      if (current.current === reading) setLoading(false)
    }
  }, [root, key, index, cursor])

  useEffect(() => {
    setError(null)
    void read()
    const timer = setInterval(() => void read(), refreshMs)
    return () => clearInterval(timer)
  }, [read])

  const go = useCallback((next: number) => setAt((now) => (now.key === key && next >= 0 && next < now.cursors.length ? { ...now, index: next } : now)), [key])
  // Another tab or filter shows nothing until its first page answers; another page of the same list keeps
  // the rows it had, under the pager's spinner, until the new page replaces them.
  const listing = shown?.key === key ? shown.listing : null
  return { listing, error, loading, reload: read, index, cursors: place.cursors, go }
}

/** How long a typed search waits before GitHub is asked. */
export const searchSettleMs = 300

/**
 * What a list's filters offer: every label of the repository and the people who can be assigned (they
 * answer for authors too), not only those on the page shown.
 */
export function useFilterOptions(root: string): { labels: string[]; people: string[] } {
  const [options, setOptions] = useState<{ root: string; labels: string[]; people: string[] } | null>(null)
  useEffect(() => {
    let stopped = false
    const sorted = (values: string[]) => [...new Set(values)].sort((left, right) => left.localeCompare(right))
    void Promise.allSettled([api.githubLabels(root), api.assignableReviewers(root, '')]).then(([labels, people]) => {
      if (stopped) return
      setOptions({
        root,
        labels: labels.status === 'fulfilled' ? sorted(labels.value.map((label) => label.name)) : [],
        people: people.status === 'fulfilled' ? sorted(people.value.filter((person) => person.isTeam !== true).map((person) => person.login)) : [],
      })
    })
    return () => {
      stopped = true
    }
  }, [root])
  return options?.root === root ? options : { labels: [], people: [] }
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

const draftOptions: { value: PullRequestFilters['draft']; label: string }[] = [
  { value: 'any', label: 'Drafts and ready' },
  { value: 'ready', label: 'Ready for review' },
  { value: 'draft', label: 'Drafts only' },
]

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
  const query = useSettled(filters.query, searchSettleMs)
  const { listing, error, loading, reload, index, cursors, go } = usePagedListing(project.path, { kind: 'prs', state: tab, filters: { ...filters, query } })
  const options = useFilterOptions(project.path)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => listRef.current?.scrollTo({ top: 0 }), [index])
  const [sheetOpen, setSheetOpen] = useState(false)
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const set = (patch: Partial<PullRequestFilters>) => setFilters((current) => ({ ...current, ...patch }))
  const sheetFields: SheetField[] = [
    { kind: 'select', label: 'Author', value: filters.author ?? anyValue, options: people('Any author', options.people), onChange: (value) => set({ author: fromAny(value) }) },
    { kind: 'select', label: 'Label', value: filters.label ?? anyValue, options: people('Any label', options.labels), onChange: (value) => set({ label: fromAny(value) }) },
    { kind: 'select', label: 'Draft', value: filters.draft, options: draftOptions, onChange: (value) => set({ draft: draftOptions.find((option) => option.value === value)?.value ?? 'any' }) },
  ]

  const prs = useMemo(() => (listing?.kind === 'prs' ? listing.page.items : []), [listing])
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
    <div className="relative flex min-h-0 flex-1 flex-col">
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
      <div className={`flex items-center gap-2 ${pageX} pb-4`}>
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
        <SearchBox value={filters.query} placeholder="Search title, number, branch, author, label" onChange={(text) => setFilters((current) => ({ ...current, query: text }))} />
        <FilterButton fields={sheetFields} open={sheetOpen} onClick={() => setSheetOpen(!sheetOpen)} place="row" />
      </div>
      <FilterChips fields={sheetFields} className={`${pageX} -mt-1.5 pb-3`} />
      <div className={`flex min-h-0 flex-1 border-t ${pageDivider}`}>
        <div ref={listRef} className={splitList(selected !== null)}>
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
          {known && prs.length === 0 &&
            (filtered ? (
              <Empty title={`No ${tab === 'all' ? '' : `${tab} `}pull requests match`} detail="Try other words or clear the filters." action={<button type="button" onClick={clearFilters} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title={`No ${tab === 'all' ? '' : `${tab} `}pull requests`} detail={`${repository.nameWithOwner} has none right now.`} />
            ))}
          {known && prs.length > 0 && (
            <ul className={`${pageMx} divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60`}>
              {prs.map((item) => (
                <li key={item.number}>
                  <PullRequestRow item={item} selected={item.number === selected} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                </li>
              ))}
            </ul>
          )}
          {listing !== null && prs.length > 0 && <Pager index={index} cursors={cursors} total={listing.page.totalCount} shown={prs.length} loading={loading} onPage={go} />}
        </div>
        {selected !== null && <DetailPane key={selected} project={project} kind="prs" number={selected} pullRequest={selectedPr} issue={null} onMaximise={() => onMaximise('pr', selected)} onClose={() => setSelected(null)} />}
      </div>
      <FilterSheet open={sheetOpen} fields={sheetFields} onClose={closeSheet} />
    </div>
  )
}
