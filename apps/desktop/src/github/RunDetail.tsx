import { useCallback, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubActionRun, GithubActionRunDetail } from '@/api/schema'
import { DetailSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { isLive, jobDuration, jobSummary, runActions, runDuration, runLabels, formatDuration, elapsedMs, runVisual, type GithubActionJob } from '@/github/actions-model'
import { BranchChip, RunGlyph, RunStatePill, RunStatusIcon, eventName, runTone } from '@/github/actions-parts'
import { ChevronIcon, CloseIcon, CopyIcon, MaximiseIcon, RefreshIcon } from '@/github/icons'
import { ActionButton, StatPill, type HeroButton } from '@/github/ItemHero'
import { LogViewer } from '@/github/LogViewer'
import { IconButton, dot } from '@/github/page-parts'
import { Avatar, OpenLink, ago, useNow } from '@/github/parts'
import { actionsLivePolicy, actionsPolicy } from '@/lib/poll-model'
import { pageX } from '@/lib/page'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

// One workflow run, read through `megabrain github run --json`, in the language of a pull request's
// detail: its state, title, branch, commit, who started it, how and how long it took, its actions
// (re-run all, re-run the failed jobs, cancel), and its jobs, each opening on its steps, with a log
// viewer for any job. It reads again every 10 s while the run is queued or running. The pane on the
// Actions page and the maximised pane item share every part.

type Detail = GithubActionRunDetail

/** The run with its jobs; read again every 10 s while it runs, and once a minute otherwise. */
function useRunDetail(root: string, runId: number, seed: GithubActionRun | null) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const live = detail === null ? seed !== null && isLive(seed) : isLive(detail)
  const reload = usePoll(
    live ? actionsLivePolicy : actionsPolicy,
    async (current) => {
      try {
        const value = await api.githubActionRun(root, runId)
        if (!current()) return
        setDetail((previous) => reuse(previous, value))
        setError(null)
      } catch (cause: unknown) {
        if (current()) setError(cause)
        throw cause
      }
    },
    [root, runId, live],
  )
  return { detail, error, reload, live }
}

type Action = 'rerun' | 'rerun-failed' | 'cancel'

/** Re-run all, re-run failed and cancel, as the run's state allows; gh's message shows when one fails. */
function useRunActions(root: string, run: GithubActionRun | null, onDone: () => void) {
  const [running, setRunning] = useState<Action | null>(null)
  const [error, setError] = useState<unknown>(null)
  const allowed = run === null ? { rerun: false, rerunFailed: false, cancel: false } : runActions(run)
  const act = (action: Action) => {
    if (run === null) return
    setRunning(action)
    setError(null)
    api.githubActionRunAction(root, run.id, action).then(
      () => {
        setRunning(null)
        onDone()
      },
      (cause: unknown) => {
        setRunning(null)
        setError(cause)
      },
    )
  }
  const buttons: HeroButton[] = [
    ...(allowed.rerunFailed ? [{ label: 'Re-run failed jobs', tone: 'accent', icon: <RefreshIcon size={14} />, running: running === 'rerun-failed', disabled: running !== null, onClick: () => act('rerun-failed') } satisfies HeroButton] : []),
    ...(allowed.rerun ? [{ label: 'Re-run all jobs', tone: allowed.rerunFailed ? 'quiet' : 'accent', icon: allowed.rerunFailed ? undefined : <RefreshIcon size={14} />, running: running === 'rerun', disabled: running !== null, onClick: () => act('rerun') } satisfies HeroButton] : []),
    ...(allowed.cancel ? [{ label: 'Cancel run', tone: 'quiet', icon: <CloseIcon size={13} />, running: running === 'cancel', disabled: running !== null, onClick: () => act('cancel') } satisfies HeroButton] : []),
  ]
  return { buttons, error }
}

function CommitChip({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard.writeText(sha).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  return (
    <button type="button" onClick={copy} aria-label={`Copy commit ${sha}`} className="group/sha inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2 font-mono text-[11.5px] leading-[22px] text-ink-200 hover:bg-white/[0.10]">
      {sha.slice(0, 7)}
      <span className={`font-sans ${copied ? 'text-ok' : 'text-ink-500 opacity-0 group-hover/sha:opacity-100 group-focus-visible/sha:opacity-100'}`}>{copied ? 'Copied' : <CopyIcon size={11} />}</span>
    </button>
  )
}

/** Who started the run, how and when, on which branch and commit, and how long it took. */
function RunFacts({ run, now }: { run: GithubActionRun; now: number }) {
  const duration = formatDuration(runDuration(run, now))
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-ink-400">
      <span className="flex items-center gap-2">
        <Avatar login={run.actor.replace(/\[bot\]$/, '')} size={20} />
        <span className="font-semibold text-ink-200">{run.actor}</span>
        <span>
          {run.event === 'workflow_dispatch' ? 'started it by hand' : `triggered via ${eventName(run.event)}`} {ago(run.createdAt, now)}
        </span>
      </span>
      {dot}
      <BranchChip branch={run.branch} className="max-w-[16rem]" />
      <CommitChip sha={run.sha} />
      {run.prNumber !== null && <span className="text-ink-300 tabular-nums">#{run.prNumber}</span>}
      {duration !== '' && (
        <>
          {dot}
          <span className="tabular-nums">{isLive(run) ? `running ${duration}` : duration}</span>
        </>
      )}
    </div>
  )
}

/** The jobs, failures open on their steps; a job's log opens in place of the list. */
function JobsList({ detail, now, onLog }: { detail: Detail; now: number; onLog: (job: GithubActionJob) => void }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(detail.jobs.filter((job) => runVisual(job) === 'failure').map((job) => job.id)))
  const summary = jobSummary(detail.jobs)
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const parts = (['failure', 'running', 'queued', 'waiting', 'success', 'cancelled', 'skipped', 'neutral'] as const).flatMap((visual) => {
    const count = summary.counts[visual] ?? 0
    return count === 0 ? [] : [`${count} ${runLabels[visual].toLowerCase()}`]
  })
  return (
    <section className="overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900">
      <header className="flex items-center gap-2.5 border-b border-white/[0.05] px-5 py-3.5">
        <RunStatusIcon item={detail} size={15} />
        <h3 className="text-[13.5px] font-semibold text-ink-100">
          {summary.total} {summary.total === 1 ? 'job' : 'jobs'}
        </h3>
        <span className="ml-auto text-[12px] text-ink-400 tabular-nums">{parts.join(' · ')}</span>
      </header>
      {detail.jobs.length === 0 && <p className="px-5 py-4 text-[13px] text-ink-400">{isLive(detail) ? 'The jobs have not started yet.' : 'This run has no jobs.'}</p>}
      <ul className="divide-y divide-white/[0.04]">
        {detail.jobs.map((job) => {
          const expanded = open.has(job.id)
          const duration = formatDuration(jobDuration(job, now))
          const hasLog = job.status !== 'queued' && job.conclusion !== 'skipped'
          return (
            <li key={job.id}>
              <div className="group flex h-11 items-center gap-1 pr-3 pl-2 text-[13px]">
                <button type="button" onClick={() => toggle(job.id)} aria-expanded={expanded} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[12px] px-2 text-left hover:bg-white/[0.03]">
                  <span className={`shrink-0 text-ink-500 transition-transform duration-[var(--motion-enter)] ${expanded ? 'rotate-90' : ''}`}>
                    <ChevronIcon size={12} />
                  </span>
                  <RunStatusIcon item={job} size={15} tip />
                  <span className="min-w-0 truncate font-medium text-ink-200">{job.name}</span>
                  <span className="ml-auto shrink-0 pl-3 text-[12px] text-ink-400 tabular-nums">{duration}</span>
                </button>
                {hasLog && (
                  <button type="button" onClick={() => onLog(job)} className="h-7 shrink-0 rounded-full px-2.5 text-[12px] font-semibold text-ink-400 hover:bg-white/[0.06] hover:text-ink-100">
                    Log
                  </button>
                )}
              </div>
              {expanded && (
                <ol className="pb-2">
                  {job.steps.length === 0 && <li className="px-12 py-1.5 text-[12.5px] text-ink-500">No steps yet.</li>}
                  {job.steps.map((step) => {
                    const failed = runVisual(step) === 'failure'
                    const stepTime = formatDuration(elapsedMs(step.startedAt, isLive(step) ? null : step.completedAt, now))
                    return (
                      <li key={step.number} className={`flex h-9 items-center gap-2.5 pr-3 pl-12 text-[12.5px] ${failed ? 'bg-bad/[0.06]' : ''}`}>
                        <RunStatusIcon item={step} size={13} tip />
                        <span className="w-5 shrink-0 text-right text-ink-500 tabular-nums">{step.number}</span>
                        <span className={`min-w-0 truncate ${failed ? 'font-semibold text-bad' : 'text-ink-300'}`}>{step.name}</span>
                        {failed && (
                          <button type="button" onClick={() => onLog(job)} className="h-7 shrink-0 rounded-full border border-bad/30 bg-bad/[0.10] px-2.5 text-[11.5px] font-semibold text-bad hover:bg-bad/[0.18]">
                            View log
                          </button>
                        )}
                        <span className="ml-auto shrink-0 pl-3 text-[12px] text-ink-500 tabular-nums">{stepTime}</span>
                      </li>
                    )
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Everything under the run's header: its jobs, or one job's log. */
function RunBody({ root, detail, error, now, padded }: { root: string; detail: Detail | null; error: unknown; now: number; padded: string }) {
  const [log, setLog] = useState<number | null>(null)
  const back = useCallback(() => setLog(null), [])
  const job = log === null ? undefined : detail?.jobs.find((entry) => entry.id === log)
  if (detail !== null && job !== undefined)
    return (
      <div className={`flex min-h-0 flex-1 flex-col ${padded} pb-6`}>
        <LogViewer root={root} runId={detail.id} job={job} onBack={back} />
      </div>
    )
  return (
    <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto ${padded} pb-8`}>
      {error !== null && <ErrorNote error={error} />}
      {detail === null && error === null && <DetailSkeleton />}
      {detail !== null && <JobsList key={detail.id} detail={detail} now={now} onLog={(entry) => setLog(entry.id)} />}
    </div>
  )
}

function ActionBar({ buttons, error }: { buttons: HeroButton[]; error: unknown }) {
  if (buttons.length === 0 && error === null) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {buttons.map((button) => (
          <ActionButton key={button.label} button={button} />
        ))}
      </div>
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}

/** The run beside the Actions page's list, as a pull request's detail sits beside its list. */
export function RunPane({ root, run, onMaximise, onClose, onChanged }: { root: string; run: GithubActionRun; onMaximise: () => void; onClose: () => void; onChanged: () => void }) {
  const { detail, error, reload, live } = useRunDetail(root, run.id, run)
  // A running clock ticks each second; a finished run only needs its "ago" kept fresh.
  const now = useNow(live ? 1000 : 30_000)
  const shown = detail ?? run
  const actions = useRunActions(root, shown, () => {
    reload()
    onChanged()
  })
  return (
    <aside className="flex min-h-0 w-[min(580px,50%)] shrink-0 flex-col border-l border-white/[0.06] bg-ink-950">
      <header className={`space-y-3.5 ${pageX} pt-6 pb-5`}>
        <div className="flex items-center gap-2">
          <RunStatePill item={shown} />
          <span className="text-[13px] font-semibold text-ink-400 tabular-nums">
            {shown.name} #{shown.number}
          </span>
          {shown.attempt > 1 && <span className="text-[12.5px] text-ink-500">attempt {shown.attempt}</span>}
          <span className="ml-auto" />
          <OpenLink url={shown.url} />
          <IconButton label="Maximise" onClick={onMaximise}>
            <MaximiseIcon size={14} />
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
        <h2 className="text-[21px] leading-[1.3] font-semibold tracking-[-0.02em] text-balance text-ink-100 select-text">{shown.title}</h2>
        <RunFacts run={shown} now={now} />
        <ActionBar buttons={actions.buttons} error={actions.error} />
      </header>
      <RunBody key={run.id} root={root} detail={detail} error={error} now={now} padded={pageX} />
    </aside>
  )
}

function Stats({ detail, now }: { detail: Detail; now: number }) {
  const visual = runVisual(detail)
  const summary = jobSummary(detail.jobs)
  const failed = summary.counts.failure ?? 0
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <StatPill tone={runTone[visual]}>
        <RunGlyph visual={visual} size={13} />
        {runLabels[visual]}
      </StatPill>
      <StatPill>{formatDuration(runDuration(detail, now)) || 'Not started'}</StatPill>
      <StatPill tone={failed > 0 ? 'text-bad' : 'text-ink-300'}>
        {summary.total} {summary.total === 1 ? 'job' : 'jobs'}
        {failed > 0 ? `, ${failed} failed` : ''}
      </StatPill>
      {detail.attempt > 1 && <StatPill>Attempt {detail.attempt}</StatPill>}
    </div>
  )
}

/** A run maximised as a pane item: a hero like a pull request's, then its jobs or a job's log. */
export function RunPage({ root, runId }: { root: string; runId: number }) {
  const { detail, error, reload, live } = useRunDetail(root, runId, null)
  const now = useNow(live ? 1000 : 30_000)
  const actions = useRunActions(root, detail, reload)
  let hero: ReactNode = null
  if (detail !== null)
    hero = (
      <header className={`${pageX} pt-7 pb-5`}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-8 gap-y-4 max-[760px]:grid-cols-1">
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2.5">
              <RunStatePill item={detail} />
              <span className="text-[14px] font-medium text-ink-500 tabular-nums">
                {detail.name} #{detail.number}
              </span>
            </div>
            <h1 className="text-[26px] leading-[1.25] font-semibold tracking-[-0.02em] text-balance text-ink-100 select-text">{detail.title}</h1>
            <RunFacts run={detail} now={now} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ActionBar buttons={actions.buttons} error={null} />
            <OpenLink url={detail.url} />
            <IconButton label="Refresh" onClick={reload}>
              <RefreshIcon size={15} />
            </IconButton>
          </div>
        </div>
        <Stats detail={detail} now={now} />
        {actions.error !== null && (
          <div className="mt-4">
            <ErrorNote error={actions.error} />
          </div>
        )}
      </header>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hero}
      <RunBody root={root} detail={detail} error={error} now={now} padded={`${pageX} ${detail === null ? 'pt-7' : ''}`} />
    </div>
  )
}
