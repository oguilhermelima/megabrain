import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubActionLog } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'
import { Tooltip } from '@/components/Tooltip'
import { firstErrorLine, logLine, logLines, searchLog, type GithubActionJob, type LogTone } from '@/github/actions-model'
import { RunStatusIcon } from '@/github/actions-parts'
import { ArrowRightIcon, ChevronIcon } from '@/github/icons'
import { openOnGithub } from '@/github/parts'

// One job's log, read through `github run-log`: numbered mono lines without colours, GitHub's
// markers drawn as tones (errors red, warnings amber, groups as headings), a search that steps
// through its matches, a jump to the first error (where it opens when the job failed), and a note
// when the CLI cut the log short.

const toneClass: Record<LogTone, string> = {
  error: 'bg-bad/[0.10] text-bad',
  warning: 'bg-warn/[0.08] text-warn',
  group: 'font-semibold text-ink-100',
  command: 'text-accent',
  muted: 'text-ink-600',
  plain: 'text-ink-300',
}

const iconButton = 'grid size-8 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100 disabled:opacity-40 disabled:hover:bg-transparent'

// Memoised: the run around it re-renders every second while it runs, and a log can be long.
export const LogViewer = memo(function LogViewer({ root, runId, job, onBack }: { root: string; runId: number; job: GithubActionJob; onBack: () => void }) {
  const [log, setLog] = useState<GithubActionLog | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [match, setMatch] = useState(0)
  const [target, setTarget] = useState<number | null>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    setLog(null)
    setError(null)
    api.githubActionRunLog(root, runId, job.id).then(
      (value) => current && setLog(value),
      (cause: unknown) => current && setError(cause),
    )
    return () => {
      current = false
    }
  }, [root, runId, job.id])

  const lines = useMemo(() => (log === null ? [] : logLines(log.log)), [log])
  const shown = useMemo(() => lines.map(logLine), [lines])
  const firstError = useMemo(() => firstErrorLine(lines), [lines])
  const matches = useMemo(() => searchLog(lines, query), [lines, query])
  const failed = job.conclusion === 'failure' || job.conclusion === 'timed_out'

  // A failed job opens on its first error.
  useEffect(() => {
    if (log !== null && failed && firstError !== null) setTarget(firstError)
  }, [log, failed, firstError])

  useEffect(() => setMatch(0), [query])
  useEffect(() => {
    const line = matches[match]
    if (line !== undefined) setTarget(line)
  }, [matches, match])

  useEffect(() => {
    if (target === null) return
    body.current?.querySelector(`[data-line="${target}"]`)?.scrollIntoView({ block: 'center' })
  }, [target, shown])

  const step = (by: number) => matches.length > 0 && setMatch((current) => (current + by + matches.length) % matches.length)
  const matched = new Set(matches)

  return (
    <section aria-label={`${job.name} log`} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] px-3 py-2.5">
        <button type="button" onClick={onBack} className="flex h-8 shrink-0 items-center gap-1 rounded-full pr-3 pl-2 text-[12.5px] font-semibold text-ink-300 hover:bg-white/[0.06] hover:text-ink-100">
          <span className="rotate-180">
            <ChevronIcon size={13} />
          </span>
          Jobs
        </button>
        <span aria-hidden="true" className="h-5 w-px bg-white/[0.08]" />
        <RunStatusIcon item={job} size={14} />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-100">{job.name}</h3>
        <label className="flex h-8 w-[min(240px,40%)] min-w-[140px] items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-ink-400 focus-within:border-accent/60 focus-within:text-ink-200">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.4 10.4 3.1 3.1" />
          </svg>
          <input
            type="search"
            value={query}
            placeholder="Search the log"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') step(event.shiftKey ? -1 : 1)
              if (event.key === 'Escape') setQuery('')
            }}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-100 outline-none placeholder:text-ink-500"
          />
        </label>
        {query.trim() !== '' && <span className="shrink-0 text-[12px] text-ink-400 tabular-nums">{matches.length === 0 ? 'No matches' : `${match + 1} of ${matches.length}`}</span>}
        <Tooltip text="Previous match">
          {(anchor) => (
            <button {...anchor} type="button" aria-label="Previous match" disabled={matches.length === 0} onClick={() => step(-1)} className={iconButton}>
              <span className="-rotate-90">
                <ChevronIcon size={13} />
              </span>
            </button>
          )}
        </Tooltip>
        <Tooltip text="Next match">
          {(anchor) => (
            <button {...anchor} type="button" aria-label="Next match" disabled={matches.length === 0} onClick={() => step(1)} className={iconButton}>
              <span className="rotate-90">
                <ChevronIcon size={13} />
              </span>
            </button>
          )}
        </Tooltip>
        <button
          type="button"
          disabled={firstError === null}
          onClick={() => firstError !== null && (setTarget(null), queueMicrotask(() => setTarget(firstError)))}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.10] bg-white/[0.05] px-3 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.10] disabled:opacity-40 disabled:hover:bg-white/[0.05]"
        >
          <span className="text-bad">
            <ArrowRightIcon size={12} />
          </span>
          First error
        </button>
      </header>
      {log?.truncated === true && (
        <p className="flex flex-wrap items-center gap-x-2 border-b border-white/[0.05] bg-warn/[0.06] px-4 py-2 text-[12.5px] text-warn">
          The log is too long to show whole; this is its start.
          <button type="button" onClick={() => void openOnGithub(job.url)} className="font-semibold underline-offset-2 hover:underline">
            Open the full log on GitHub
          </button>
        </p>
      )}
      <div ref={body} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[20px] select-text">
        {error !== null && (
          <div className="px-4 py-2 font-sans">
            <ErrorNote error={error} />
          </div>
        )}
        {log === null && error === null && (
          <div className="flex items-center gap-2 px-4 py-2 font-sans text-[12.5px] text-ink-400">
            <Spinner />
            Reading the log…
          </div>
        )}
        {log !== null && lines.length === 0 && <p className="px-4 py-2 font-sans text-[12.5px] text-ink-400">This job wrote no log.</p>}
        {shown.map((line, index) => (
          <div
            key={index}
            data-line={index}
            className={`grid grid-cols-[4.5rem_minmax(0,1fr)] ${index === target ? 'bg-accent/[0.16]' : matched.has(index) ? 'bg-white/[0.05]' : toneClass[line.tone].includes('bg-') ? toneClass[line.tone].split(' ')[0] : ''}`}
          >
            <span className="pr-4 text-right text-ink-600 tabular-nums select-none">{index + 1}</span>
            <span className={`pr-4 break-words whitespace-pre-wrap ${toneClass[line.tone].split(' ').filter((name) => !name.startsWith('bg-')).join(' ')}`}>{line.text === '' ? ' ' : line.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
})
