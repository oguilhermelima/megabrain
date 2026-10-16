import { useMemo, useState } from 'react'
import type { GithubReviewThread } from '@/api/schema'
import { MarkdownText } from '@/chat/markdown'
import { ErrorNote, Segmented, Spinner } from '@/components/ui'
import { ArrowRightIcon, FileIcon } from '@/github/icons'
import { Avatar, ago, useNow } from '@/github/parts'
import { unresolvedCount } from '@/github/review-model'

// A review thread as GitHub shows it on the diff: its comments, a reply box, and resolve or reopen.
// A resolved thread starts folded to one line; an outdated one says so, since its line has changed.
// The Threads tab lists them all by file, unresolved first, each with a way back to its line.

export interface ThreadActions {
  reply: (threadId: string, body: string) => Promise<void>
  resolve: (threadId: string, resolved: boolean) => Promise<void>
}

const quiet = 'h-7 rounded-full px-3 text-[12px] font-semibold text-ink-300 hover:bg-white/[0.07] hover:text-ink-100 disabled:opacity-60'

export function ReviewThread({ thread, actions }: { thread: GithubReviewThread; actions: ThreadActions }) {
  const now = useNow(60_000)
  const [open, setOpen] = useState(!thread.isResolved)
  const [replying, setReplying] = useState(false)
  const [body, setBody] = useState('')
  const [running, setRunning] = useState<'reply' | 'resolve' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const run = async (kind: 'reply' | 'resolve', action: () => Promise<void>) => {
    setRunning(kind)
    setError(null)
    try {
      await action()
      return true
    } catch (caught: unknown) {
      setError(caught)
      return false
    } finally {
      setRunning(null)
    }
  }
  const send = async () => {
    if (body.trim() === '' || running !== null) return
    if (await run('reply', () => actions.reply(thread.id, body.trim()))) {
      setBody('')
      setReplying(false)
    }
  }
  const first = thread.comments[0]

  return (
    <div className={`rounded-[14px] border font-sans ${thread.isResolved ? 'border-white/[0.05] bg-white/[0.02]' : 'border-white/[0.08] bg-ink-950'}`}>
      <div className="flex items-center gap-2 px-3.5 py-2 text-[12px]">
        <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="flex min-w-0 items-center gap-2 text-left text-ink-300 hover:text-ink-100">
          <Avatar login={first?.author?.login ?? null} size={16} />
          <span className="truncate font-semibold">{first?.author?.login ?? 'ghost'}</span>
          {!open && <span className="truncate text-ink-500">{first?.body.split('\n')[0]}</span>}
          <span className="shrink-0 text-ink-500">· {thread.comments.length === 1 ? '1 comment' : `${thread.comments.length} comments`}</span>
        </button>
        <span className="ml-auto" />
        {thread.isOutdated && <span className="shrink-0 rounded-full bg-warn/[0.14] px-1.5 leading-[18px] font-semibold text-warn">Outdated</span>}
        {thread.isResolved && <span className="shrink-0 rounded-full bg-ok/[0.14] px-1.5 leading-[18px] font-semibold text-ok">Resolved</span>}
        <button type="button" disabled={running !== null} onClick={() => void run('resolve', () => actions.resolve(thread.id, !thread.isResolved))} className={quiet}>
          {running === 'resolve' ? <Spinner /> : thread.isResolved ? 'Unresolve' : 'Resolve'}
        </button>
      </div>
      {open && (
        <div className="space-y-4 border-t border-white/[0.06] px-3.5 py-3">
          {thread.comments.map((comment) => (
            <div key={comment.id} className="space-y-1">
              <p className="flex items-center gap-2 text-[11.5px] text-ink-400">
                <Avatar login={comment.author?.login ?? null} size={16} />
                <span className="font-semibold text-ink-200">{comment.author?.login ?? 'ghost'}</span>
                <span>{ago(comment.createdAt, now)}</span>
              </p>
              <MarkdownText text={comment.body} className="pl-6 text-[13px] text-ink-100 select-text" />
            </div>
          ))}
          {replying ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                rows={3}
                value={body}
                disabled={running !== null}
                placeholder="Reply"
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setReplying(false)
                  }
                  if (event.key === 'Enter' && event.metaKey) void send()
                }}
                className="w-full resize-y rounded-[10px] border border-white/[0.08] bg-black/40 px-3 py-2 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setReplying(false)} disabled={running !== null} className={quiet}>
                  Cancel
                </button>
                <button type="button" disabled={body.trim() === '' || running !== null} onClick={() => void send()} className="h-7 rounded-full bg-accent px-3 text-[12px] font-semibold text-accent-ink hover:bg-[#a3aeff] disabled:bg-ink-700 disabled:text-ink-400">
                  {running === 'reply' ? <Spinner /> : 'Reply'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setReplying(true)} className="h-8 w-full rounded-[10px] border border-white/[0.08] bg-black/30 px-3 text-left text-[12.5px] text-ink-500 hover:border-white/[0.16] hover:text-ink-300">
              Reply…
            </button>
          )}
        </div>
      )}
      {error !== null && (
        <div className="px-3 pb-2.5">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  )
}

export interface ThreadFocus {
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
}

/** The Threads tab: every thread by file, the unresolved ones alone by default. */
export function ThreadsList({ threads, error, onRetry, actions, onShow }: { threads: GithubReviewThread[] | null; error: unknown; onRetry: () => void; actions: ThreadActions; onShow: (focus: ThreadFocus) => void }) {
  const [filter, setFilter] = useState<'unresolved' | 'all'>('unresolved')
  const groups = useMemo(() => {
    const byPath = new Map<string, GithubReviewThread[]>()
    for (const thread of threads ?? []) {
      if (filter === 'unresolved' && thread.isResolved) continue
      byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread])
    }
    return [...byPath.entries()]
  }, [threads, filter])

  if (threads === null) {
    return error !== null ? (
      <div className="space-y-3">
        <ErrorNote error={error} />
        <button type="button" onClick={onRetry} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
          Try again
        </button>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-[13px] text-ink-400">
        <Spinner /> Reading the review threads
      </p>
    )
  }
  const open = unresolvedCount(threads)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Segmented
          value={filter}
          options={[
            { value: 'unresolved', label: `Unresolved (${open})` },
            { value: 'all', label: `All (${threads.length})` },
          ]}
          onChange={setFilter}
        />
      </div>
      {groups.length === 0 && <p className="text-[13.5px] text-ink-400">{threads.length === 0 ? 'No review threads on this pull request.' : 'Every thread is resolved.'}</p>}
      {groups.map(([path, list]) => (
        <section key={path} className="overflow-hidden rounded-[18px] border border-white/[0.07] bg-ink-900">
          <header className="flex items-center gap-2.5 border-b border-white/[0.05] px-4 py-2.5">
            <span className="text-ink-400">
              <FileIcon size={14} />
            </span>
            <h3 className="min-w-0 truncate font-mono text-[12.5px] text-ink-200" title={path}>
              {path}
            </h3>
            <span className="ml-auto shrink-0 text-[11.5px] text-ink-500 tabular-nums">{list.length === 1 ? '1 thread' : `${list.length} threads`}</span>
          </header>
          <div className="space-y-3 p-3">
            {list.map((thread) => (
              <div key={thread.id} className="space-y-1.5">
                <button type="button" onClick={() => onShow({ path: thread.path, line: thread.line, side: thread.side })} className="inline-flex h-6 items-center gap-1 rounded-full bg-accent/[0.10] px-2.5 font-mono text-[11.5px] font-semibold text-accent transition-colors duration-[var(--motion-enter)] hover:bg-accent/[0.18]">
                  {thread.line === null ? 'Show the file' : `Line ${thread.line}${thread.side === 'LEFT' ? ' (old side)' : ''}`}
                  <ArrowRightIcon size={11} />
                </button>
                <ReviewThread thread={thread} actions={actions} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
