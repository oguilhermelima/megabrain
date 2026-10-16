import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubReviewer, GithubReviewers } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'
import { Avatar } from '@/github/parts'

// The bar under a pull request's header that says who is asked to review (with a people picker to
// ask or withdraw) and what each reviewer said. Whether it can merge lives in the merge box.

const reviewTone: Record<string, { label: string; className: string }> = {
  approved: { label: 'approved', className: 'text-ok' },
  changes_requested: { label: 'requested changes', className: 'text-bad' },
  commented: { label: 'commented', className: 'text-ink-300' },
  dismissed: { label: 'dismissed', className: 'text-ink-500' },
  pending: { label: 'pending', className: 'text-warn' },
}

/** Each reviewer's latest review, newest first; GitHub lists every review a person submitted. */
function latestReviews(reviews: GithubReviewers['reviews']) {
  const byLogin = new Map<string, GithubReviewers['reviews'][number]>()
  for (const review of reviews) {
    const login = review.author?.login ?? 'ghost'
    const seen = byLogin.get(login)
    if (seen === undefined || (review.submittedAt ?? '') >= (seen.submittedAt ?? '')) byLogin.set(login, review)
  }
  return [...byLogin.values()].sort((left, right) => (right.submittedAt ?? '').localeCompare(left.submittedAt ?? ''))
}

/** A search over the people and teams who can review; a login typed in full can be asked as it is. */
function PeoplePicker({ root, exclude, onPick, onClose }: { root: string; exclude: ReadonlySet<string>; onPick: (login: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<GithubReviewer[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const asked = useRef(0)
  useEffect(() => {
    const ask = ++asked.current
    const timer = setTimeout(() => {
      api.assignableReviewers(root, query).then(
        (found) => {
          if (ask !== asked.current) return
          setPeople(found)
          setError(null)
        },
        (caught: unknown) => {
          if (ask === asked.current) setError(caught)
        },
      )
    }, 200)
    return () => clearTimeout(timer)
  }, [root, query])
  const typed = query.trim().replace(/^@/, '')
  const listed = (people ?? []).filter((person) => !exclude.has(person.login))
  const offerTyped = /^[\w.-]+$/.test(typed) && !listed.some((person) => person.login.toLowerCase() === typed.toLowerCase()) && !exclude.has(typed)

  return (
    <div
      role="dialog"
      aria-label="Request a review"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
      className="absolute top-full left-0 z-30 mt-2 w-[300px] space-y-2 rounded-[16px] border border-white/[0.12] bg-ink-900 p-2.5 shadow-2xl"
    >
      <input
        autoFocus
        type="search"
        value={query}
        placeholder="Search people and teams"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && offerTyped) onPick(typed)
        }}
        className="h-8 w-full rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
      />
      {error !== null && <ErrorNote error={error} />}
      <ul className="max-h-[240px] overflow-y-auto">
        {people === null && error === null && (
          <li className="flex items-center gap-2 px-2 py-2 text-[12.5px] text-ink-400">
            <Spinner /> Searching
          </li>
        )}
        {listed.map((person) => (
          <li key={person.login}>
            {/* request-review asks people only; a team shows but cannot be picked yet. */}
            <button
              type="button"
              disabled={person.isTeam === true}
              title={person.isTeam === true ? 'Teams cannot be asked from here yet; ask on GitHub.' : undefined}
              onClick={() => onPick(person.login)}
              className="flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Avatar login={person.isTeam === true ? null : person.login} size={20} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-semibold text-ink-100">{person.login}</span>
                {person.name !== null && <span className="block truncate text-[11px] text-ink-500">{person.isTeam === true ? `Team · ${person.name}` : person.name}</span>}
              </span>
            </button>
          </li>
        ))}
        {offerTyped && (
          <li>
            <button type="button" onClick={() => onPick(typed)} className="flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[12.5px] text-ink-200 hover:bg-white/[0.06]">
              Ask <span className="font-semibold text-ink-100">{typed}</span>
            </button>
          </li>
        )}
        {people !== null && listed.length === 0 && !offerTyped && <li className="px-2 py-2 text-[12.5px] text-ink-500">Nobody else matches.</li>}
      </ul>
    </div>
  )
}

export function ReviewersSummary({ root, reviewers, error, canRequest, onRequest }: { root: string; reviewers: GithubReviewers | null; error: unknown; canRequest: boolean; onRequest: (logins: string[], remove: boolean) => Promise<void> }) {
  const [picking, setPicking] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<unknown>(null)
  const change = async (login: string, remove: boolean) => {
    setPicking(false)
    setRunning(login)
    setRefusal(null)
    try {
      await onRequest([login], remove)
    } catch (caught: unknown) {
      setRefusal(caught)
    } finally {
      setRunning(null)
    }
  }

  if (reviewers === null) {
    return error === null ? (
      <span className="flex items-center gap-2 text-[12.5px] text-ink-500">
        <Spinner /> Reading the reviewers
      </span>
    ) : (
      <ErrorNote error={error} />
    )
  }
  const reviews = latestReviews(reviewers.reviews)
  const exclude = new Set(reviewers.requested.map((person) => person.login))

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      {reviews.map((review) => {
        const tone = reviewTone[review.state] ?? { label: review.state, className: 'text-ink-300' }
        return (
          <span key={review.author?.login ?? 'ghost'} className="flex items-center gap-1.5 text-[12.5px]">
            <Avatar login={review.author?.login ?? null} size={18} />
            <span className="font-semibold text-ink-200">{review.author?.login ?? 'ghost'}</span>
            <span className={tone.className}>{tone.label}</span>
          </span>
        )
      })}
      {reviewers.requested.length > 0 && <span className="text-[12.5px] text-ink-500">Waiting on</span>}
      {reviewers.requested.map((person) => (
        <span key={person.login} className="flex h-7 items-center gap-1.5 rounded-full border border-white/[0.10] bg-white/[0.04] pr-1 pl-1 text-[12.5px] text-ink-200">
          <Avatar login={person.isTeam === true ? null : person.login} size={20} />
          <span className="font-semibold">{person.login}</span>
          {canRequest && person.isTeam !== true && (
            <button type="button" disabled={running !== null} onClick={() => void change(person.login, true)} aria-label={`Withdraw the review request to ${person.login}`} title="Withdraw the request" className="flex size-5 items-center justify-center rounded-full text-ink-400 hover:bg-white/[0.10] hover:text-ink-100">
              {running === person.login ? <Spinner /> : '×'}
            </button>
          )}
        </span>
      ))}
      {reviews.length === 0 && reviewers.requested.length === 0 && <span className="text-[12.5px] text-ink-500">No reviewers yet.</span>}
      {canRequest && (
        <span className="relative">
          <button type="button" disabled={running !== null} onClick={() => setPicking((current) => !current)} aria-expanded={picking} className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-white/[0.16] px-2.5 text-[12px] font-semibold text-ink-300 hover:border-white/[0.30] hover:text-ink-100 disabled:opacity-60">
            {running !== null && !exclude.has(running) ? <Spinner /> : '+'} Request review
          </button>
          {picking && <PeoplePicker root={root} exclude={exclude} onPick={(login) => void change(login, false)} onClose={() => setPicking(false)} />}
        </span>
      )}
      {refusal !== null && (
        <div className="basis-full">
          <ErrorNote error={refusal} />
        </div>
      )}
    </div>
  )
}
