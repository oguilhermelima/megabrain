import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubIssue, GithubPullRequest, Project } from '@/api/schema'
import { relativeAge } from '@/advanced/projects-model'
import { MarkdownText } from '@/chat/markdown'
import { ErrorNote, Spinner } from '@/components/ui'
import {
  checkSummary,
  emptyIssueFilters,
  emptyPullRequestFilters,
  filterIssues,
  filterPullRequests,
  githubRepository,
  issueFilterOptions,
  issueTabCounts,
  pullRequestFilterOptions,
  pullRequestTabCounts,
  type IssueFilters,
  type IssueTab,
  type PullRequestFilters,
  type PullRequestTab,
} from '@/github/github-model'
import { CloseIcon, CommentIcon, IssueIcon, LinkIcon, MilestoneIcon, PullRequestIcon, RefreshIcon } from '@/github/icons'
import { Avatar, CheckGlyph, ChecksBadge, IssueStateIcon, LabelChip, LineCounts, PullRequestStateIcon, ReviewChip, SkeletonRows, StatePill, checkStateTone, checkTitle } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'

// A repository's pull requests or issues, read through `megabrain github … --json`: tabs with counts,
// search and filters over one listing of every state, rich rows, and a detail pane with the body and
// comments on the right.

const listLimit = 200
const refreshMs = 60_000

type Listing = { kind: 'prs'; items: GithubPullRequest[]; fetchedAt: string } | { kind: 'issues'; items: GithubIssue[]; fetchedAt: string }

function ago(iso: string | null, now: number): string {
  const age = relativeAge(iso, now)
  return age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function useListing(project: Project, kind: GithubKind) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next: Listing =
        kind === 'prs'
          ? { kind, ...(await api.githubPullRequests(project.path, 'all', listLimit)) }
          : { kind, ...(await api.githubIssues(project.path, 'all', listLimit)) }
      setListing(next)
      setError(null)
    } catch (cause: unknown) {
      setError(cause)
    } finally {
      setLoading(false)
    }
  }, [project.path, kind])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => clearInterval(timer)
  }, [load])

  return { listing, error, loading, reload: load }
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

function PullRequestRow({ item, selected, compact, now, onSelect }: { item: GithubPullRequest; selected: boolean; compact: boolean; now: number; onSelect: () => void }) {
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
        {!compact && <ReviewChip decision={item.reviewDecision} />}
        <ChecksBadge checks={item.checks} />
        <span className={`flex w-8 items-center gap-1 tabular-nums ${item.comments === 0 ? 'invisible' : ''}`}>
          <CommentIcon size={14} />
          {item.comments}
        </span>
        {!compact && <LineCounts additions={item.additions} deletions={item.deletions} />}
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

/** "Open on GitHub": links do not open from the app yet, so this copies the address instead. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={copy}
        title="Links don't open from the app yet; this copies the address so you can paste it in your browser."
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.06] px-3 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.12]"
      >
        <LinkIcon size={13} />
        {copied === 'copied' ? 'Link copied' : 'Copy GitHub link'}
      </button>
      {copied === 'failed' && <span className="max-w-[260px] truncate text-[11.5px] text-ink-400 select-text">{url}</span>}
    </div>
  )
}

function ChecksList({ item }: { item: GithubPullRequest }) {
  const [open, setOpen] = useState(false)
  const summary = checkSummary(item.checks)
  if (item.checks.length === 0) return null
  const order = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }
  const sorted = [...item.checks].sort((left, right) => order[left.state] - order[right.state])
  const shown = open ? sorted : sorted.slice(0, 6)
  return (
    <section className="rounded-[20px] border border-white/[0.08] bg-ink-900">
      <header className="flex items-center gap-2 px-4 pt-3 pb-1.5">
        <h3 className="text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">Checks</h3>
        <span className="text-[12px] text-ink-400">{checkTitle(summary)}</span>
      </header>
      <ul className="px-2 pb-2">
        {shown.map((check, index) => (
          <li key={`${check.name}-${index}`} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1 text-[12.5px]">
            <span className={checkStateTone[check.state]}>
              <CheckGlyph state={check.state} size={13} />
            </span>
            <span className="min-w-0 truncate text-ink-200" title={check.name}>
              {check.name}
            </span>
          </li>
        ))}
      </ul>
      {sorted.length > 6 && (
        <button type="button" onClick={() => setOpen((current) => !current)} className="w-full border-t border-white/[0.06] py-2 text-[12px] font-semibold text-ink-400 hover:text-ink-100">
          {open ? 'Show fewer' : `Show all ${sorted.length}`}
        </button>
      )}
    </section>
  )
}

function DetailPane({ project, kind, pullRequest, issue, onClose }: { project: Project; kind: GithubKind; pullRequest: GithubPullRequest | null; issue: GithubIssue | null; onClose: () => void }) {
  const number = pullRequest?.number ?? issue?.number ?? 0
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

  return (
    <aside className="flex min-h-0 w-[min(580px,50%)] shrink-0 flex-col border-l border-white/[0.06] bg-ink-950">
      <header className="space-y-3 px-6 pt-5 pb-4">
        <div className="flex items-center gap-2">
          <StatePill kind={kind === 'prs' ? 'pr' : 'issue'} state={state} draft={pullRequest?.isDraft ?? false} />
          <span className="text-[13px] font-semibold text-ink-400 tabular-nums">#{number}</span>
          <span className="ml-auto" />
          {url !== '' && <CopyLink url={url} />}
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
              {dot}
              <LineCounts additions={pullRequest.additions} deletions={pullRequest.deletions} />
            </>
          )}
        </div>
        {(labels.length > 0 || (pullRequest !== null && pullRequest.reviewDecision !== null) || (issue !== null && (issue.assignees.length > 0 || issue.milestone !== null))) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {pullRequest !== null && <ReviewChip decision={pullRequest.reviewDecision} />}
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
        {pullRequest !== null && <ChecksList item={pullRequest} />}
        {error !== null && <ErrorNote error={error} />}
        {detail === null && error === null && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-ink-400">
            <Spinner /> Reading the description and comments…
          </div>
        )}
        {detail !== null && (
          <>
            <section className="rounded-[20px] border border-white/[0.08] bg-ink-900 px-5 py-4 select-text">
              {detail.body.trim() === '' ? <p className="text-[13.5px] text-ink-400 italic">No description provided.</p> : <MarkdownText text={detail.body} className="text-ink-200" />}
            </section>
            {detail.comments.length > 0 && (
              <section className="space-y-3">
                <h3 className="px-1 text-[11.5px] font-semibold tracking-[0.08em] text-ink-400 uppercase">
                  {detail.comments.length} {detail.comments.length === 1 ? 'comment' : 'comments'}
                </h3>
                {detail.comments.map((comment, index) => (
                  <article key={`${comment.url}-${index}`} className="flex gap-3">
                    <Avatar login={comment.author?.login ?? null} size={28} />
                    <div className="min-w-0 flex-1 rounded-[18px] border border-white/[0.06] bg-white/[0.03] px-4 py-3">
                      <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px]">
                        <span className="font-semibold text-ink-100">{comment.author?.login ?? 'ghost'}</span>
                        <span className="text-ink-400">{ago(comment.createdAt, now)}</span>
                      </p>
                      <div className="select-text">
                        <MarkdownText text={comment.body} className="text-ink-200" />
                      </div>
                    </div>
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

export function GithubPage({ project, kind, focus, onKind, onClose }: { project: Project; kind: GithubKind; focus: number | null; onKind: (kind: GithubKind) => void; onClose: () => void }) {
  const repository = githubRepository(project.remote)
  const { listing, error, loading, reload } = useListing(project, kind)
  const now = useNow(30_000)
  const [prTab, setPrTab] = useState<PullRequestTab>('open')
  const [issueTab, setIssueTab] = useState<IssueTab>('open')
  const [prFilters, setPrFilters] = useState<PullRequestFilters>(emptyPullRequestFilters)
  const [issueFilters, setIssueFilters] = useState<IssueFilters>(emptyIssueFilters)
  const [selected, setSelected] = useState<number | null>(null)

  const prs = listing?.kind === 'prs' ? listing.items : []
  const issues = listing?.kind === 'issues' ? listing.items : []
  const shownPrs = useMemo(() => filterPullRequests(prs, prFilters, prTab), [prs, prFilters, prTab])
  const shownIssues = useMemo(() => filterIssues(issues, issueFilters, issueTab), [issues, issueFilters, issueTab])
  const prOptions = useMemo(() => pullRequestFilterOptions(prs), [prs])
  const issueOptions = useMemo(() => issueFilterOptions(issues), [issues])
  const prCounts = pullRequestTabCounts(prs)
  const issueCounts = issueTabCounts(issues)
  const filtered = kind === 'prs' ? JSON.stringify(prFilters) !== JSON.stringify(emptyPullRequestFilters) : JSON.stringify(issueFilters) !== JSON.stringify(emptyIssueFilters)
  const clearFilters = () => (kind === 'prs' ? setPrFilters(emptyPullRequestFilters) : setIssueFilters(emptyIssueFilters))
  const shownCount = kind === 'prs' ? shownPrs.length : shownIssues.length
  const selectedPr = kind === 'prs' ? (prs.find((item) => item.number === selected) ?? null) : null
  const selectedIssue = kind === 'issues' ? (issues.find((item) => item.number === selected) ?? null) : null
  const known = listing !== null
  const counted = (count: number) => (known ? count : null)
  const truncated = (listing?.items.length ?? 0) >= listLimit
  const noun = kind === 'prs' ? 'pull requests' : 'issues'
  const tabName = kind === 'prs' ? prTab : issueTab

  // Opened on one pull request (a worktree row's number): select it on its own tab once it is listed.
  const focused = useRef(false)
  useEffect(() => {
    if (focus === null || focused.current || listing?.kind !== 'prs') return
    const item = listing.items.find((entry) => entry.number === focus)
    focused.current = true
    if (item === undefined) return
    setPrTab(item.state)
    setSelected(item.number)
  }, [focus, listing])

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
                <span className="shrink-0">updated {ago(listing.fetchedAt, now)}</span>
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
              { value: 'open', label: 'Open', count: counted(prCounts.open) },
              { value: 'merged', label: 'Merged', count: counted(prCounts.merged) },
              { value: 'closed', label: 'Closed', count: counted(prCounts.closed) },
              { value: 'all', label: 'All', count: counted(prCounts.all) },
            ]}
          />
        ) : (
          <Tabs
            value={issueTab}
            onChange={setIssueTab}
            tabs={[
              { value: 'open', label: 'Open', count: counted(issueCounts.open) },
              { value: 'closed', label: 'Closed', count: counted(issueCounts.closed) },
              { value: 'all', label: 'All', count: counted(issueCounts.all) },
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
            <FilterSelect
              label="Review"
              value={prFilters.review}
              options={[
                { value: 'any', label: 'Any review' },
                { value: 'review_required', label: 'Review required' },
                { value: 'approved', label: 'Approved' },
                { value: 'changes_requested', label: 'Changes requested' },
                { value: 'none', label: 'No review needed' },
              ]}
              onChange={(review) => setPrFilters({ ...prFilters, review })}
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
          {known && shownCount === 0 &&
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
                      <PullRequestRow item={item} selected={item.number === selected} compact={selected !== null} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                    </li>
                  ))
                : shownIssues.map((item) => (
                    <li key={item.number}>
                      <IssueRow item={item} selected={item.number === selected} now={now} onSelect={() => setSelected(item.number === selected ? null : item.number)} />
                    </li>
                  ))}
            </ul>
          )}
          {known && truncated && <p className="px-7 pt-3 text-[12px] text-ink-500">Showing the {listLimit} most recently updated {noun}.</p>}
        </div>
        {selected !== null && (selectedPr !== null || selectedIssue !== null) && (
          <DetailPane key={`${kind}-${selected}`} project={project} kind={kind} pullRequest={selectedPr} issue={selectedIssue} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  )
}
