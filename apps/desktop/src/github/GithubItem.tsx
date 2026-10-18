import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubDetail, GithubMergeMethod, GithubReview, GithubReviewEvent } from '@/api/schema'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { DetailSkeleton } from '@/components/Skeleton'
import { ErrorNote, Segmented, Spinner } from '@/components/ui'
import type { MenuRow } from '@/components/ContextMenu'
import { checkSummary } from '@/github/github-model'
import { CommentIcon, FileIcon, MergedIcon, ReviewIcon } from '@/github/icons'
import { ItemHero, StatPill, type HeroButton } from '@/github/ItemHero'
import { heroActions, type HeroPrimary } from '@/github/item-hero-model'
import { CheckGlyph, ChecksList, ConversationThread, LineCounts, checkTitle, useNow } from '@/github/parts'
import { PullRequestFiles, type PendingControls, type ReviewContext } from '@/github/PullRequestFiles'
import { ReviewersSummary } from '@/github/ReviewSummary'
import { MergeBox, mergeMethods, secondaryLabel, type MergeBoxRunning } from '@/github/MergeBox'
import { mergeBox, type PrimaryAction, type SecondaryAction, type Tone } from '@/github/merge-box-model'
import { ThreadsList, type ThreadActions, type ThreadFocus } from '@/github/ReviewThread'
import { useReviewers, useReviewThreads } from '@/github/usePullRequestReview'
import { usePullRequestFiles } from '@/github/usePullRequestFiles'
import { addPending, editPending, issueStateActions, removePending, reviewPayload, unresolvedCount, type GithubItemKind, type IssueStateAction, type PendingComment } from '@/github/review-model'
import { LatestRunPill } from '@/github/actions-parts'
import { RunPage } from '@/github/RunDetail'
import { pageX } from '@/lib/page'

// One pull request or issue maximised as a pane item: a hero with its state, title, author, branches,
// stat pills and an action bar (see ItemHero), its reviewers, and tabs that stick under the top of the
// pane for the conversation (ending in the merge box, which holds every merge and close action), the
// changed files (with review threads under their lines and inline comments kept pending until a review
// submits them), every review thread, and the checks. Every write goes through `megabrain github`
// and shows gh's own message when it fails.

type Tab = 'conversation' | 'files' | 'threads' | 'checks'

const boxTone: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', muted: 'text-ink-300' }
type ReviewDecision = NonNullable<GithubDetail['reviewDecision']>
const reviewTone: Record<ReviewDecision, string> = { approved: 'text-ok', changes_requested: 'text-bad', review_required: 'text-ink-300' }
const reviewLabel: Record<ReviewDecision, string> = { approved: 'Approved', changes_requested: 'Changes requested', review_required: 'Review required' }

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

function TabBar({ value, tabs, onChange }: { value: Tab; tabs: { value: Tab; label: string; count?: number }[]; onChange: (tab: Tab) => void }) {
  return (
    <div role="tablist" className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-white/[0.08] bg-white/[0.04] p-1">
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.value)}
            className={`flex h-8 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-[var(--motion-enter)] ${selected ? 'bg-white/[0.12] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
          >
            {tab.label}
            {tab.count !== undefined && <span className={`min-w-[20px] rounded-full px-1.5 text-center text-[11px] leading-[18px] tabular-nums ${selected ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.06] text-ink-400'}`}>{tab.count.toLocaleString()}</span>}
          </button>
        )
      })}
    </div>
  )
}

const pill = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60'
const pillTones = {
  primary: `${pill} bg-accent text-accent-ink hover:bg-[#a3aeff]`,
  secondary: `${pill} border border-white/[0.12] bg-white/[0.06] text-ink-100 hover:bg-white/[0.12]`,
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
function ReviewPanel({ pending, error, onSubmit, onConfirmChanges, onClose }: { pending: PendingComment[]; error: unknown; onSubmit: (review: GithubReview) => Promise<boolean>; onConfirmChanges: (review: GithubReview) => void; onClose: () => void }) {
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
    // Requesting changes blocks the merge, so it goes through the confirm dialog like a merge does.
    if (event === 'request-changes') {
      onConfirmChanges(payload.review)
      return
    }
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
      className="absolute top-full right-6 z-30 -mt-2 w-[min(460px,calc(100%-3rem))] space-y-3 rounded-[20px] border border-white/[0.12] bg-ink-900 p-4 shadow-2xl"
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

/** A maximised pull request, issue or workflow run (number is then the run's id). */
export function GithubItemView({ root, kind, number }: { root: string; kind: GithubItemKind; number: number }) {
  return kind === 'run' ? <RunPage root={root} runId={number} /> : <ItemView root={root} kind={kind} number={number} />
}

function ItemView({ root, kind, number }: { root: string; kind: 'pr' | 'issue'; number: number }) {
  const now = useNow(60_000)
  const [tab, setTab] = useState<Tab>('conversation')
  const { detail: read, error, loading, reload } = useDetail(root, kind, number)
  const files = usePullRequestFiles(root, number, kind === 'pr' && tab === 'files')
  const reviewThreads = useReviewThreads(root, number, kind === 'pr')
  const reviewers = useReviewers(root, number, kind === 'pr')
  const [focus, setFocus] = useState<ThreadFocus | null>(null)
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

  const { reply: replyThread, resolve: resolveThread } = reviewThreads
  const threadActions: ThreadActions = useMemo(() => ({ reply: replyThread, resolve: resolveThread }), [replyThread, resolveThread])
  const clearFocus = useCallback(() => setFocus(null), [])
  const threadList = reviewThreads.threads
  const reviewContext: ReviewContext = useMemo(() => ({ controls, threads: threadList ?? [], threadActions, focus, onFocused: clearFocus }), [controls, threadList, threadActions, focus, clearFocus])

  const addComment = (body: string) =>
    comment.run(async () => {
      await api.addComment(root, number, body)
      await reload()
    })

  const sendReview = async (submitted: GithubReview) => {
    await api.submitReview(root, number, submitted)
    setPending([])
    void reload()
    void reviewThreads.reload()
    void reviewers.reload()
  }
  const submitReview = (submitted: GithubReview) => review.run(() => sendReview(submitted))
  const confirmChanges = (submitted: GithubReview) =>
    setConfirm({
      title: `Request changes on #${number}?`,
      body: submitted.comments === undefined ? 'Your review blocks the merge until it is dismissed or answered.' : `Your review and its ${submitted.comments.length} ${submitted.comments.length === 1 ? 'comment' : 'comments'} block the merge until answered.`,
      action: 'Request changes',
      run: async () => {
        await sendReview(submitted)
        setReviewing(false)
      },
    })

  // Merge box writes: each re-reads the detail and the reviewers once it lands.
  const [autoMerge, setAutoMergeOn] = useState<GithubMergeMethod | null>(null)
  const refreshReadiness = () => {
    void reload()
    void reviewers.reload()
  }
  const enableAutoMerge = async () => {
    await api.setAutoMerge(root, number, method)
    setAutoMergeOn(method)
    refreshReadiness()
  }
  const disableAutoMerge = () =>
    state.run(async () => {
      await api.setAutoMerge(root, number, null)
      setAutoMergeOn(null)
      refreshReadiness()
    })
  const markReady = () =>
    state.run(async () => {
      await api.setPrReady(root, number, true)
      await reload()
      void reviewers.reload()
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
  const draft = detail?.isDraft ?? false
  const methodLabel = mergeMethods.find((option) => option.value === method)?.label ?? 'Merge'
  const box = mergeBox({ state: currentState, isDraft: draft, checks, readiness: reviewers.reviewers, autoMerge })

  // The merge box's buttons: merging, enabling auto-merge and closing ask first; the rest run here.
  const [boxRunning, setBoxRunning] = useState<MergeBoxRunning>(null)
  const mergeBoxRef = useRef<HTMLElement>(null)
  const boxWrite = (action: PrimaryAction | SecondaryAction, write: () => Promise<unknown>) => {
    setBoxRunning(action)
    void write().finally(() => setBoxRunning(null))
  }
  const confirmMerge = () =>
    setConfirm({
      title: `Merge #${number}?`,
      body: `${methodLabel} into ${detail?.baseRefName ?? 'the base branch'} on GitHub.`,
      action: 'Merge',
      tone: 'primary',
      run: confirmed('merge'),
    })
  const confirmAutoMerge = (reason: string) =>
    setConfirm({
      title: `Enable auto-merge on #${number}?`,
      body: `${methodLabel} into ${detail?.baseRefName ?? 'the base branch'} as soon as GitHub allows it. ${reason}`,
      action: 'Enable auto-merge',
      tone: 'primary',
      run: enableAutoMerge,
    })
  const onBoxPrimary = (action: PrimaryAction) => {
    if (action === 'merge') confirmMerge()
    else if (action === 'auto-merge') confirmAutoMerge(box.detail)
    else if (action === 'disable-auto-merge') boxWrite(action, disableAutoMerge)
    else if (action === 'ready-for-review') boxWrite(action, markReady)
    else boxWrite(action, () => changePrState('reopen'))
  }
  const onBoxSecondary = (action: SecondaryAction) => {
    if (action === 'close') setConfirm({ title: `Close pull request #${number}?`, body: 'The pull request closes without merging. It can be reopened later.', action: 'Close pull request', run: confirmed('close') })
    else if (action === 'rerun-failed') boxWrite(action, () => state.run(async () => {
      await api.rerunChecks(root, number, true)
      refreshReadiness()
    }))
    else boxWrite(action, () => state.run(async () => {
      await api.setPrReady(root, number, false)
      refreshReadiness()
    }))
  }

  const issueActions =
    kind === 'issue' && detail !== null
      ? issueStateActions(currentState).map((action) => (
          <Pill key={action.label} tone="secondary" disabled={state.running} onClick={() => void changeIssueState(action)}>
            {action.label}
          </Pill>
        ))
      : undefined

  const showMergeBox = () => {
    setTab('conversation')
    // The conversation mounts on this render when another tab was showing; scroll once it has.
    requestAnimationFrame(() => mergeBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const hero = heroActions({ state: currentState, isDraft: draft, box })
  const writing = boxRunning !== null
  const reviewButton = (tone: HeroButton['tone']): HeroButton => ({
    label: pending.length > 0 ? `Review changes (${pending.length})` : 'Review changes',
    tone,
    icon: <ReviewIcon size={15} />,
    onClick: () => setReviewing((current) => !current),
  })
  const heroButton = (action: HeroPrimary): HeroButton => {
    if (action === 'review') return reviewButton('accent')
    if (action === 'merge') return { label: 'Merge', tone: 'merge', icon: <MergedIcon size={15} />, disabled: writing, onClick: confirmMerge }
    if (action === 'ready-for-review') return { label: 'Ready for review', tone: 'accent', running: boxRunning === action, disabled: writing, onClick: () => onBoxPrimary(action) }
    return { label: 'Reopen', tone: 'quiet', running: boxRunning === action, disabled: writing, onClick: () => onBoxPrimary(action) }
  }
  const heroMore: MenuRow[] =
    kind === 'pr'
      ? hero.more.map((action) => ({ label: secondaryLabel[action], danger: action === 'close', disabled: writing, onSelect: () => onBoxSecondary(action) }))
      : detail === null
        ? []
        : issueStateActions(currentState).map((action) => ({ label: action.state === 'open' ? 'Reopen issue' : action.label, danger: action.state === 'closed', disabled: state.running, onSelect: () => void changeIssueState(action) }))

  const checkTone = summary.state === 'failing' ? 'text-bad' : summary.state === 'pending' ? 'text-warn' : summary.state === 'passing' ? 'text-ok' : 'text-ink-300'
  const stats =
    detail === null ? null : kind === 'pr' ? (
      <>
        {files.pages.total !== null && (
          <StatPill onClick={() => setTab('files')} title="Show the changed files">
            <FileIcon size={13} />
            {files.pages.total.toLocaleString()} {files.pages.total === 1 ? 'file' : 'files'}
          </StatPill>
        )}
        {detail.additions !== undefined && detail.deletions !== undefined && (
          <StatPill>
            <LineCounts additions={detail.additions} deletions={detail.deletions} />
          </StatPill>
        )}
        <StatPill onClick={() => setTab('checks')} tone={checkTone} title="Show the checks">
          <CheckGlyph state={summary.state} size={13} />
          {checkTitle(summary)}
        </StatPill>
        {detail.headRefName !== undefined && <LatestRunPill root={root} branch={detail.headRefName} />}
        {detail.reviewDecision !== undefined && detail.reviewDecision !== null && (
          <StatPill tone={reviewTone[detail.reviewDecision]}>
            <ReviewIcon size={13} />
            {reviewLabel[detail.reviewDecision]}
          </StatPill>
        )}
        {open && (
          <StatPill onClick={showMergeBox} tone={boxTone[box.tone]} title="Show the merge box">
            <MergedIcon size={13} />
            {box.headline}
          </StatPill>
        )}
      </>
    ) : (
      <StatPill>
        <CommentIcon size={13} />
        {detail.comments.length} {detail.comments.length === 1 ? 'comment' : 'comments'}
      </StatPill>
    )

  const header = (
    <ItemHero
      kind={kind}
      number={number}
      detail={detail}
      title={title}
      state={currentState}
      draft={draft}
      now={now}
      loading={loading}
      onRefresh={() => void reload()}
      primary={kind === 'pr' && hero.primary !== null && detail !== null ? heroButton(hero.primary) : null}
      secondary={kind === 'pr' && hero.review && detail !== null ? [reviewButton('quiet')] : []}
      more={heroMore}
      stats={stats}
      compact={tab === 'files'}
    >
      {kind === 'pr' && detail !== null && tab !== 'files' && <ReviewersSummary root={root} reviewers={reviewers.reviewers} error={reviewers.error} canRequest={open} onRequest={reviewers.request} />}
      {reviewing && kind === 'pr' && (
        <ReviewPanel
          pending={pending}
          error={review.error}
          onSubmit={submitReview}
          onConfirmChanges={confirmChanges}
          onClose={() => {
            review.clear()
            setReviewing(false)
          }}
        />
      )}
    </ItemHero>
  )

  const tabs: { value: Tab; label: string; count?: number }[] =
    kind === 'pr'
      ? [
          { value: 'conversation', label: 'Conversation', ...(detail === null ? {} : { count: detail.comments.length }) },
          { value: 'files', label: 'Files', ...(files.pages.total === null ? {} : { count: files.pages.total }) },
          { value: 'threads', label: 'Threads', ...(threadList === null ? {} : { count: unresolvedCount(threadList) }) },
          { value: 'checks', label: 'Checks', ...(detail === null ? {} : { count: checks.length }) },
        ]
      : [{ value: 'conversation', label: 'Conversation', ...(detail === null ? {} : { count: detail.comments.length }) }]

  const tabBar = (
    <div className={`${pageX} pt-1 pb-3`}>
      <TabBar value={tab} tabs={tabs} onChange={setTab} />
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-950">
      {tab === 'files' && kind === 'pr' ? (
        <>
          {header}
          <div className="border-b border-white/[0.06]">{tabBar}</div>
          <PullRequestFiles files={files} review={reviewContext} />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {header}
          {/* The tabs stay under the top of the pane once the hero scrolls away. */}
          <div className="sticky top-0 z-20 border-b border-white/[0.06] bg-ink-950">{tabBar}</div>
          <div className={`space-y-4 ${pageX} pt-6 pb-10`}>
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
                <ConversationThread detail={detail} reviews={reviewers.reviewers?.reviews} now={now} bylineShown />
                {kind === 'pr' && (
                  <>
                    <MergeBox ref={mergeBoxRef} box={box} method={method} onMethod={setMethod} running={boxRunning} onPrimary={onBoxPrimary} onSecondary={onBoxSecondary} />
                    {state.error !== null && <ErrorNote error={state.error} />}
                  </>
                )}
                {comment.error !== null && <ErrorNote error={comment.error} />}
                {kind === 'issue' && state.error !== null && <ErrorNote error={state.error} />}
                <CommentBox onComment={addComment} actions={state.running && kind === 'issue' ? <Spinner /> : issueActions} />
              </>
            )}
            {kind === 'pr' && tab === 'threads' && (
              <ThreadsList
                threads={threadList}
                error={reviewThreads.error}
                onRetry={() => void reviewThreads.reload()}
                actions={threadActions}
                onShow={(target) => {
                  setFocus(target)
                  setTab('files')
                }}
              />
            )}
            {detail !== null && tab === 'checks' && (checks.length === 0 ? <p className="text-[13.5px] text-ink-400">No checks ran on this pull request.</p> : <ChecksList checks={checks} limit={null} />)}
          </div>
        </div>
      )}
      {confirm !== null && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}
