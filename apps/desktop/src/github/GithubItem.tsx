import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubMergeMethod, GithubPullRequestFile, GithubReview, GithubReviewEvent } from '@/api/schema'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { DetailSkeleton } from '@/components/Skeleton'
import { ErrorNote, Segmented, Spinner } from '@/components/ui'
import { checkSummary } from '@/github/github-model'
import { RefreshIcon } from '@/github/icons'
import { Avatar, CheckGlyph, ChecksList, ConversationThread, OpenLink, LineCounts, ReviewChip, StatePill, ago, checkTitle, useNow } from '@/github/parts'
import { PullRequestFiles, type PendingControls } from '@/github/PullRequestFiles'
import { addPending, editPending, issueStateActions, removePending, reviewPayload, type IssueStateAction, type PendingComment } from '@/github/review-model'

// One pull request or issue maximised as a pane item: a header with its state, author, branches,
// checks and actions, and tabs for the conversation, the changed files (with inline comments kept
// pending until a review submits them) and the checks. Every write goes through `megabrain github`
// and shows gh's own message when it fails.

type Tab = 'conversation' | 'files' | 'checks'

/** One write at a time per control: running while it runs, its error kept until the next try. */
function useAction() {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setRunning(true)
    setError(null)
    try {
      await action()
      return true
    } catch (caught: unknown) {
      setError(caught)
      return false
    } finally {
      setRunning(false)
    }
  }, [])
  return { running, error, run, clear: () => setError(null) }
}

function useDetail(root: string, kind: 'pr' | 'issue', number: number) {
  const [detail, setDetail] = useState<GithubDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const asked = useRef(0)
  const read = useCallback(async () => {
    const ask = ++asked.current
    setLoading(true)
    try {
      const value = kind === 'pr' ? await api.githubPullRequest(root, number) : await api.githubIssue(root, number)
      if (ask !== asked.current) return
      setDetail(value)
      setError(null)
    } catch (caught: unknown) {
      if (ask === asked.current) setError(caught)
    } finally {
      if (ask === asked.current) setLoading(false)
    }
  }, [root, kind, number])
  useEffect(() => {
    void read()
  }, [read])
  return { detail, error, loading, reload: read }
}

function useFiles(root: string, number: number, wanted: boolean) {
  const [files, setFiles] = useState<GithubPullRequestFile[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [asked, setAsked] = useState(false)
  const read = useCallback(() => {
    setAsked(true)
    setError(null)
    api.prFiles(root, number).then(setFiles, setError)
  }, [root, number])
  useEffect(() => {
    if (wanted && !asked) read()
  }, [wanted, asked, read])
  return { files, error, reload: read }
}

function TabBar({ value, tabs, onChange }: { value: Tab; tabs: { value: Tab; label: string; count?: number }[]; onChange: (tab: Tab) => void }) {
  return (
    <div role="tablist" className="flex gap-1 px-8">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === value}
          onClick={() => onChange(tab.value)}
          className={`-mb-px flex h-10 items-center gap-2 border-b-2 px-3 text-[13px] font-semibold transition-colors ${tab.value === value ? 'border-accent text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-200'}`}
        >
          {tab.label}
          {tab.count !== undefined && <span className="rounded-full bg-white/[0.08] px-1.5 text-[11px] leading-[18px] text-ink-300 tabular-nums">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

const pill = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60'
const pillTones = {
  primary: `${pill} bg-accent text-accent-ink hover:bg-[#a3aeff]`,
  secondary: `${pill} border border-white/[0.12] bg-white/[0.06] text-ink-100 hover:bg-white/[0.12]`,
  danger: `${pill} border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20`,
  merge: `${pill} bg-[#238636] text-white hover:bg-[#2ea043]`,
}

function Pill({ tone, onClick, disabled, children, label }: { tone: keyof typeof pillTones; onClick: () => void; disabled?: boolean; children: ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} className={pillTones[tone]}>
      {children}
    </button>
  )
}

const reviewEvents: { value: GithubReviewEvent; label: string }[] = [
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'request-changes', label: 'Request changes' },
]

/** The review card: a verdict, a summary and the pending inline comments, submitted together. */
function ReviewPanel({ pending, error, onSubmit, onClose }: { pending: PendingComment[]; error: unknown; onSubmit: (review: GithubReview) => Promise<boolean>; onClose: () => void }) {
  const [event, setEvent] = useState<GithubReviewEvent>('comment')
  const [body, setBody] = useState('')
  const [running, setRunning] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const submit = async () => {
    const payload = reviewPayload(event, body, pending)
    if (!payload.ok) {
      setRefusal(payload.error)
      return
    }
    setRefusal(null)
    setRunning(true)
    const sent = await onSubmit(payload.review)
    setRunning(false)
    if (sent) {
      setBody('')
      onClose()
    }
  }
  return (
    <div
      role="dialog"
      aria-label="Review"
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Escape' && !running) onClose()
      }}
      className="absolute top-full right-8 z-20 mt-2 w-[min(460px,calc(100%-4rem))] space-y-3 rounded-[20px] border border-white/[0.12] bg-ink-900 p-4 shadow-2xl"
    >
      <Segmented value={event} options={reviewEvents} onChange={setEvent} disabled={running} />
      <textarea
        autoFocus
        rows={5}
        value={body}
        disabled={running}
        placeholder={event === 'request-changes' ? 'What needs to change' : 'Leave a summary (optional for an approval)'}
        onChange={(change) => setBody(change.target.value)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter' && keyEvent.metaKey) void submit()
        }}
        className="w-full resize-y rounded-[12px] border border-white/[0.08] bg-black/40 px-3 py-2 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
      />
      <p className="text-[12px] text-ink-400">
        {pending.length === 0 ? 'No comments on the diff.' : `${pending.length} pending ${pending.length === 1 ? 'comment' : 'comments'} on the diff go with this review.`}
      </p>
      {refusal !== null && <p className="text-[12.5px] text-bad">{refusal}</p>}
      {error !== null && <ErrorNote error={error} />}
      <div className="flex justify-end gap-2">
        <Pill tone="secondary" onClick={onClose} disabled={running}>
          Cancel
        </Pill>
        <Pill tone={event === 'approve' ? 'merge' : 'primary'} onClick={() => void submit()} disabled={running}>
          {running ? <Spinner /> : 'Submit review'}
        </Pill>
      </div>
    </div>
  )
}

const mergeMethods: { value: GithubMergeMethod; label: string }[] = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Create a merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
]

/** The comment box under the conversation; `actions` sits beside its button (an issue's state). */
function CommentBox({ onComment, actions }: { onComment: (body: string) => Promise<boolean>; actions?: ReactNode }) {
  const [body, setBody] = useState('')
  const [running, setRunning] = useState(false)
  const send = async () => {
    if (body.trim() === '' || running) return
    setRunning(true)
    const sent = await onComment(body.trim())
    setRunning(false)
    if (sent) setBody('')
  }
  return (
    <section className="space-y-2 rounded-[20px] border border-white/[0.08] bg-ink-900 p-3">
      <textarea
        rows={4}
        value={body}
        disabled={running}
        placeholder="Add a comment (markdown)"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey) void send()
        }}
        className="w-full resize-y rounded-[12px] border border-white/[0.08] bg-black/40 px-3 py-2 text-[13.5px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions}
        <Pill tone="primary" onClick={() => void send()} disabled={running || body.trim() === ''}>
          {running ? <Spinner /> : 'Comment'}
        </Pill>
      </div>
    </section>
  )
}

export function GithubItemView({ root, kind, number }: { root: string; kind: 'pr' | 'issue'; number: number }) {
  const now = useNow(60_000)
  const [tab, setTab] = useState<Tab>('conversation')
  const { detail: read, error, loading, reload } = useDetail(root, kind, number)
  const { files, error: filesError, reload: reloadFiles } = useFiles(root, number, kind === 'pr' && tab === 'files')
  const [localState, setLocalState] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingComment[]>([])
  const [reviewing, setReviewing] = useState(false)
  const [method, setMethod] = useState<GithubMergeMethod>('squash')
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const comment = useAction()
  const review = useAction()
  const state = useAction()

  // A changed state shows at once and wins until the detail read after the write reports it.
  const detail = read === null || localState === null ? read : { ...read, state: localState }
  useEffect(() => {
    if (read !== null && localState === read.state) setLocalState(null)
  }, [read, localState])

  const controls: PendingControls = useMemo(
    () => ({
      pending,
      onAdd: (target, body) => setPending((current) => addPending(current, target, body, crypto.randomUUID())),
      onEdit: (id, body) => setPending((current) => editPending(current, id, body)),
      onRemove: (id) => setPending((current) => removePending(current, id)),
    }),
    [pending],
  )

  const addComment = (body: string) =>
    comment.run(async () => {
      await api.addComment(root, number, body)
      await reload()
    })

  const submitReview = (submitted: GithubReview) =>
    review.run(async () => {
      await api.submitReview(root, number, submitted)
      setPending([])
      void reload()
    })

  const writePrState = (action: 'merge' | 'close' | 'reopen') => async () => {
    await api.setPrState(root, number, action, action === 'merge' ? { method } : undefined)
    setLocalState(action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'open')
    void reload()
  }
  // Merge and close go through the confirm dialog, which shows its own refusal; reopen runs here.
  const confirmed = writePrState
  const changePrState = (action: 'merge' | 'close' | 'reopen') => state.run(writePrState(action))

  const changeIssueState = (action: IssueStateAction) =>
    state.run(async () => {
      if (action.state === 'closed') await api.setIssueState(root, number, 'closed', action.reason)
      else await api.setIssueState(root, number, 'open')
      setLocalState(action.state)
      void reload()
    })

  const title = detail?.title ?? `#${number}`
  const currentState = detail?.state ?? 'open'
  const checks = detail?.checks ?? []
  const summary = checkSummary(checks)
  const open = currentState === 'open'

  const issueActions =
    kind === 'issue' && detail !== null
      ? issueStateActions(currentState).map((action) => (
          <Pill key={action.label} tone="secondary" disabled={state.running} onClick={() => void changeIssueState(action)}>
            {action.label}
          </Pill>
        ))
      : undefined

  const header = (
    <header className="relative space-y-3 px-8 pt-6 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        {detail !== null && <StatePill kind={kind} state={currentState} draft={detail.isDraft ?? false} />}
        <span className="text-[13px] font-semibold text-ink-400 tabular-nums">#{number}</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => void reload()} aria-label="Refresh" title="Refresh" className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100">
          <span className={loading && read !== null ? 'animate-spin' : ''}>
            <RefreshIcon size={14} />
          </span>
        </button>
        {detail !== null && <OpenLink url={detail.url} />}
        {kind === 'pr' && detail !== null && open && (
          <>
            <Pill tone="secondary" onClick={() => setReviewing((current) => !current)}>
              Review{pending.length > 0 ? ` (${pending.length})` : ''}
            </Pill>
            <label className="relative flex h-8 items-center rounded-full border border-white/[0.12] bg-white/[0.06] text-[12.5px] font-semibold text-ink-100">
              <span className="sr-only">Merge method</span>
              <select value={method} onChange={(event) => setMethod(event.target.value as GithubMergeMethod)} style={{ colorScheme: 'dark' }} className="h-full cursor-pointer appearance-none rounded-full bg-transparent pr-3 pl-3 outline-none">
                {mergeMethods.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Pill
              tone="merge"
              disabled={state.running}
              onClick={() =>
                setConfirm({
                  title: `Merge #${number}?`,
                  body: `${mergeMethods.find((option) => option.value === method)?.label ?? 'Merge'} into ${detail.baseRefName ?? 'the base branch'} on GitHub.`,
                  action: 'Merge',
                  tone: 'primary',
                  run: confirmed('merge'),
                })
              }
            >
              {state.running ? <Spinner /> : 'Merge'}
            </Pill>
            <Pill
              tone="danger"
              disabled={state.running}
              onClick={() => setConfirm({ title: `Close #${number}?`, body: 'The pull request closes without merging. It can be reopened later.', action: 'Close pull request', run: confirmed('close') })}
            >
              Close
            </Pill>
          </>
        )}
        {kind === 'pr' && detail !== null && currentState === 'closed' && (
          <Pill tone="secondary" disabled={state.running} onClick={() => void changePrState('reopen')}>
            {state.running ? <Spinner /> : 'Reopen'}
          </Pill>
        )}
      </div>
      <h1 className="text-[22px] leading-snug font-semibold tracking-[-0.01em] text-ink-100 select-text">{title}</h1>
      {detail !== null && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-ink-400">
          <Avatar login={detail.author?.login ?? null} size={18} />
          <span className="font-semibold text-ink-200">{detail.author?.login ?? 'ghost'}</span>
          <span>opened {ago(detail.createdAt, now)}</span>
          {detail.headRefName !== undefined && detail.baseRefName !== undefined && (
            <>
              <span className="text-ink-600">·</span>
              <span className="rounded-[7px] bg-white/[0.06] px-1.5 font-mono text-[11.5px] text-ink-200">{detail.headRefName}</span>
              <span className="text-ink-500">→</span>
              <span className="rounded-[7px] bg-white/[0.06] px-1.5 font-mono text-[11.5px] text-ink-200">{detail.baseRefName}</span>
            </>
          )}
          {detail.additions !== undefined && detail.deletions !== undefined && (
            <>
              <span className="text-ink-600">·</span>
              <LineCounts additions={detail.additions} deletions={detail.deletions} />
            </>
          )}
          {kind === 'pr' && (
            <>
              <span className="text-ink-600">·</span>
              <button type="button" onClick={() => setTab('checks')} className={`flex items-center gap-1 hover:text-ink-100 ${summary.state === 'failing' ? 'text-bad' : summary.state === 'pending' ? 'text-warn' : summary.state === 'passing' ? 'text-ok' : ''}`}>
                <CheckGlyph state={summary.state} size={13} />
                {checkTitle(summary)}
              </button>
            </>
          )}
          <ReviewChip decision={detail.reviewDecision ?? null} />
        </div>
      )}
      {kind === 'pr' && state.error !== null && <ErrorNote error={state.error} />}
      {reviewing && kind === 'pr' && <ReviewPanel pending={pending} error={review.error} onSubmit={submitReview} onClose={() => {
        review.clear()
        setReviewing(false)
      }} />}
    </header>
  )

  const tabs: { value: Tab; label: string; count?: number }[] =
    kind === 'pr'
      ? [
          { value: 'conversation', label: 'Conversation', ...(detail === null ? {} : { count: detail.comments.length }) },
          { value: 'files', label: 'Files', ...(files === null ? {} : { count: files.length }) },
          { value: 'checks', label: 'Checks', ...(detail === null ? {} : { count: checks.length }) },
        ]
      : [{ value: 'conversation', label: 'Conversation', ...(detail === null ? {} : { count: detail.comments.length }) }]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-950">
      {header}
      <div className="border-b border-white/[0.06]">
        <TabBar value={tab} tabs={tabs} onChange={setTab} />
      </div>
      {tab === 'files' && kind === 'pr' ? (
        <PullRequestFiles files={files} error={filesError} onRetry={reloadFiles} controls={controls} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[920px] space-y-4 px-8 py-6">
            {error !== null && (
              <div className="space-y-3">
                <ErrorNote error={error} />
                {read === null && (
                  <button type="button" onClick={() => void reload()} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
                    Try again
                  </button>
                )}
              </div>
            )}
            {detail === null && error === null && <DetailSkeleton />}
            {detail !== null && tab === 'conversation' && (
              <>
                <ConversationThread detail={detail} now={now} />
                {comment.error !== null && <ErrorNote error={comment.error} />}
                {kind === 'issue' && state.error !== null && <ErrorNote error={state.error} />}
                <CommentBox onComment={addComment} actions={state.running && kind === 'issue' ? <Spinner /> : issueActions} />
              </>
            )}
            {detail !== null && tab === 'checks' && (checks.length === 0 ? <p className="text-[13.5px] text-ink-400">No checks ran on this pull request.</p> : <ChecksList checks={checks} limit={null} />)}
          </div>
        </div>
      )}
      {confirm !== null && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
