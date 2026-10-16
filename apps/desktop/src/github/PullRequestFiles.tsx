import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GithubPullRequestFile, GithubReviewThread } from '@/api/schema'
import { languageForPath } from '@/code/code-model'
import { CodeSkeleton, RowsSkeleton } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import { highlightPatch, type PatchHighlight } from '@/github/diff-highlight'
import { ChevronIcon, CommentIcon } from '@/github/icons'
import { LineCounts } from '@/github/parts'
import { diffWindow, filesToFetch, isLargeDiff, isViewed, shownFiles, startsFolded, viewedCount } from '@/github/pr-files-model'
import { ReviewThread, type ThreadActions, type ThreadFocus } from '@/github/ReviewThread'
import { commentTarget, fileRows, parsePatch, pendingAt, placeThreads, unresolvedCount, type CommentTarget, type DiffLine, type FileRow, type PendingComment } from '@/github/review-model'
import type { PullRequestFiles as Files } from '@/github/usePullRequestFiles'

// A pull request's Files tab: the changed files with a filter on the left, and on the right each
// file's unified diff, syntax-coloured and collapsible. Both columns are virtual: only the files and
// the diff lines near the viewport are in the DOM, the list reads its files a page at a time, and a
// diff is fetched when its file nears the viewport. A click on a line's number opens a comment
// there; it stays pending, under its line, until the review is submitted. Review threads sit under
// their lines, and each file can be marked viewed, which folds it.

const statusTone: Record<GithubPullRequestFile['status'], { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-ok' },
  modified: { letter: 'M', className: 'text-warn' },
  removed: { letter: 'D', className: 'text-bad' },
  renamed: { letter: 'R', className: 'text-accent' },
}

const lineTone: Record<DiffLine['kind'], string> = {
  add: 'bg-ok/[0.10]',
  del: 'bg-bad/[0.10]',
  context: '',
  hunk: 'bg-accent/[0.08] text-ink-400',
  note: 'text-ink-500 italic',
}

const markers: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ', hunk: '', note: '' }

/** Fixed heights the virtual lists count with; a file's header and each diff line never change size. */
const headerHeight = 41
const lineHeight = 20
const navRowHeight = 44
const fileGap = 12

export interface PendingControls {
  pending: PendingComment[]
  onAdd: (target: CommentTarget, body: string) => void
  onEdit: (id: string, body: string) => void
  onRemove: (id: string) => void
}

function CommentEditor({ initial, submitLabel, onSubmit, onCancel }: { initial: string; submitLabel: string; onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial)
  return (
    <div className="space-y-2 rounded-[14px] border border-white/[0.10] bg-ink-900 p-2.5 font-sans">
      <textarea
        autoFocus
        value={body}
        rows={3}
        placeholder="Leave a comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key === 'Enter' && event.metaKey && body.trim() !== '') onSubmit(body)
        }}
        className="w-full resize-y rounded-[10px] border border-white/[0.08] bg-black/40 px-3 py-2 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] font-semibold text-ink-300 hover:bg-white/[0.07] hover:text-ink-100">
          Cancel
        </button>
        <button type="button" disabled={body.trim() === ''} onClick={() => onSubmit(body)} className="h-8 rounded-full bg-accent px-3.5 text-[12.5px] font-semibold text-accent-ink hover:bg-[#a3aeff] disabled:bg-ink-700 disabled:text-ink-400">
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

function PendingNote({ comment, controls }: { comment: PendingComment; controls: PendingControls }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <CommentEditor
        initial={comment.body}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={(body) => {
          controls.onEdit(comment.id, body)
          setEditing(false)
        }}
      />
    )
  }
  return (
    <div className="rounded-[14px] border border-warn/30 bg-warn/[0.06] px-3 py-2 font-sans">
      <p className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-warn">
        <span className="rounded-full bg-warn/[0.16] px-1.5 leading-[18px]">Pending</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => setEditing(true)} className="text-ink-300 hover:text-ink-100">
          Edit
        </button>
        <button type="button" onClick={() => controls.onRemove(comment.id)} className="text-ink-300 hover:text-bad">
          Delete
        </button>
      </p>
      <p className="text-[13px] whitespace-pre-wrap text-ink-100 select-text">{comment.body}</p>
    </div>
  )
}

const targetKey = (target: CommentTarget) => `${target.side}:${target.line}`

/** What the diff column needs besides the files: pending comments, threads and the line to bring into view. */
export interface ReviewContext {
  controls: PendingControls
  threads: GithubReviewThread[]
  threadActions: ThreadActions
  focus: ThreadFocus | null
  onFocused: () => void
}

/** The index of the diff line a thread or a jump points at, or null when no line of this diff carries it. */
function lineIndexOf(lines: DiffLine[], line: number, side: 'LEFT' | 'RIGHT'): number | null {
  const index = lines.findIndex((entry) => (side === 'LEFT' ? entry.kind !== 'add' && entry.oldLine === line : entry.kind !== 'del' && entry.newLine === line))
  return index < 0 ? null : index
}

/** One file's diff lines, virtual inside the shared scroller: `offset` is where they start in it. */
function DiffBody({ file, scroller, offset, review }: { file: GithubPullRequestFile; scroller: HTMLElement | null; offset: number; review: ReviewContext }) {
  const { controls } = review
  const lines = useMemo(() => parsePatch(file.patch), [file.patch])
  const language = languageForPath(file.path)
  const [highlight, setHighlight] = useState<PatchHighlight | null>(null)
  // The colours live while the file is on screen; leaving it drops the tree and every coloured block.
  useEffect(() => {
    const created = highlightPatch(
      lines.map((line) => line.text),
      language,
    )
    setHighlight(created)
    return () => created.dispose()
  }, [lines, language])
  const subscribe = useCallback((listener: () => void) => highlight?.subscribe(listener) ?? (() => {}), [highlight])
  const coloured = useSyncExternalStore(subscribe, () => highlight?.ready() ?? false)
  const [drafting, setDrafting] = useState<string | null>(null)
  const pendingHere = useMemo(() => controls.pending.filter((comment) => comment.path === file.path), [controls.pending, file.path])

  const placement = useMemo(() => placeThreads(file.path, lines, review.threads), [file.path, lines, review.threads])

  const rows = useMemo<FileRow[]>(() => {
    const attached = new Set(placement.at.keys())
    if (pendingHere.length > 0 || drafting !== null) {
      lines.forEach((line, index) => {
        const target = commentTarget(file.path, line)
        if (target !== null && (pendingAt(pendingHere, target).length > 0 || drafting === targetKey(target))) attached.add(index)
      })
    }
    return fileRows(lines.length, attached, placement.elsewhere.length > 0)
  }, [lines, file.path, pendingHere, drafting, placement])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => (rows[index]?.kind === 'line' ? lineHeight : 120),
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : row.kind === 'top' ? 'top' : `${row.kind}:${row.index}`
    },
    scrollMargin: offset,
    // A new virtualizer on the shared scroller would otherwise scroll it back to the top.
    initialOffset: () => scroller?.scrollTop ?? 0,
    overscan: 40,
  })

  // A jump from the Threads tab: bring the thread's line to the middle once this diff is drawn.
  const { focus, onFocused } = review
  useEffect(() => {
    if (focus === null || focus.path !== file.path) return
    const index = focus.line === null ? null : lineIndexOf(lines, focus.line, focus.side)
    const row = index === null ? 0 : rows.findIndex((entry) => entry.kind === 'line' && entry.index === index)
    requestAnimationFrame(() => virtualizer.scrollToIndex(Math.max(0, row), { align: 'center' }))
    onFocused()
  }, [focus, onFocused, file.path, lines, rows, virtualizer])

  return (
    <div className="relative overflow-x-auto overflow-y-hidden font-mono text-[12.5px] leading-[20px]" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]
        const position = { transform: `translateY(${item.start - offset}px)` }
        if (row?.kind === 'top') {
          return (
            <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} style={position} className="absolute top-0 right-0 left-0 space-y-2 border-b border-white/[0.06] bg-black/30 px-3 py-2">
              <p className="font-sans text-[11.5px] text-ink-400">On lines this diff no longer shows</p>
              {placement.elsewhere.map((thread) => (
                <ReviewThread key={thread.id} thread={thread} actions={review.threadActions} />
              ))}
            </div>
          )
        }
        const line = row === undefined ? undefined : lines[row.index]
        if (row === undefined || line === undefined) return null
        const target = commentTarget(file.path, line)
        if (row.kind === 'notes') {
          const key = target === null ? null : targetKey(target)
          return (
            <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} style={position} className="absolute top-0 right-0 left-0 space-y-2 border-y border-white/[0.06] bg-black/30 px-3 py-2">
              {(placement.at.get(row.index) ?? []).map((thread) => (
                <ReviewThread key={thread.id} thread={thread} actions={review.threadActions} />
              ))}
              {target !== null && pendingAt(pendingHere, target).map((comment) => <PendingNote key={comment.id} comment={comment} controls={controls} />)}
              {target !== null && drafting === key && (
                <CommentEditor
                  initial=""
                  submitLabel="Add to review"
                  onCancel={() => setDrafting(null)}
                  onSubmit={(body) => {
                    controls.onAdd(target, body)
                    setDrafting(null)
                  }}
                />
              )}
            </div>
          )
        }
        if (line.kind === 'hunk' || line.kind === 'note') {
          return (
            <div key={item.key} style={{ ...position, height: lineHeight }} className={`absolute top-0 left-0 w-max min-w-full px-3 text-[12px] whitespace-pre ${lineTone[line.kind]}`}>
              {line.text}
            </div>
          )
        }
        const spans = coloured ? highlight?.spans(row.index) : null
        const number = (value: number | null) => (
          <span className="w-[44px] shrink-0 border-r border-white/[0.04] px-2 text-right text-ink-600 tabular-nums select-none">
            {target === null ? (
              value
            ) : (
              <button type="button" onClick={() => setDrafting(targetKey(target))} title="Comment on this line" className="w-full text-right hover:text-accent">
                {value ?? ''}
              </button>
            )}
          </span>
        )
        return (
          <div key={item.key} style={{ ...position, height: lineHeight }} className={`absolute top-0 left-0 flex w-max min-w-full ${lineTone[line.kind]}`}>
            {number(line.oldLine)}
            {number(line.newLine)}
            <span className="pr-4 pl-1 whitespace-pre text-ink-100 select-text">
              <span className="inline-block w-4 text-ink-500 select-none">{markers[line.kind]}</span>
              {spans === null || spans === undefined
                ? line.text
                : spans.map((span, index) => (
                    <span key={index} className={span.className}>
                      {span.text}
                    </span>
                  ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** A rough height for a file not drawn yet, so the scrollbar is close before its diff arrives. */
function estimateHeight(file: GithubPullRequestFile, folded: boolean): number {
  if (folded) return headerHeight + (isLargeDiff(file) ? 52 : 0)
  return headerHeight + Math.max(1, file.additions + file.deletions + 1) * lineHeight
}

const FileSection = memo(function FileSection({
  file,
  patched,
  error,
  folded,
  onFold,
  onRetry,
  scroller,
  start,
  viewed,
  onViewed,
  review,
}: {
  file: GithubPullRequestFile
  patched: GithubPullRequestFile | undefined
  error: unknown
  folded: boolean
  onFold: (path: string) => void
  onRetry: (path: string) => void
  scroller: HTMLElement | null
  start: number
  viewed: boolean
  onViewed: (path: string, viewed: boolean) => void
  review: ReviewContext
}) {
  const tone = statusTone[file.status]
  const pendingHere = review.controls.pending.filter((comment) => comment.path === file.path).length
  const openThreads = unresolvedCount(review.threads.filter((thread) => thread.path === file.path))
  const large = isLargeDiff(file)
  return (
    <section className="rounded-[16px] border border-white/[0.08] bg-ink-950">
      <header style={{ height: headerHeight }} className="sticky top-0 z-[1] flex items-center gap-2 rounded-t-[16px] border-b border-white/[0.06] bg-ink-900 px-3">
        <button type="button" onClick={() => onFold(file.path)} aria-expanded={!folded} aria-label={folded ? `Show ${file.path}` : `Fold ${file.path}`} className="flex size-6 items-center justify-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
          <span className={`transition-transform ${folded ? '' : 'rotate-90'}`}>
            <ChevronIcon size={12} />
          </span>
        </button>
        <span className={`w-3 shrink-0 font-mono text-[11.5px] font-bold ${tone.className}`}>{tone.letter}</span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-ink-100 select-text" title={file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`}>
          {file.previousPath !== undefined && <span className="text-ink-500">{file.previousPath} → </span>}
          {file.path}
        </span>
        <span className="ml-auto" />
        {openThreads > 0 && (
          <span title={`${openThreads} unresolved ${openThreads === 1 ? 'thread' : 'threads'}`} className="flex items-center gap-1 text-[11.5px] font-semibold text-accent">
            <CommentIcon size={12} />
            {openThreads}
          </span>
        )}
        {pendingHere > 0 && (
          <span title={`${pendingHere} pending`} className="flex items-center gap-1 text-[11.5px] font-semibold text-warn">
            <CommentIcon size={12} />
            {pendingHere}
          </span>
        )}
        <LineCounts additions={file.additions} deletions={file.deletions} />
        <label className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold ${viewed ? 'border-accent/40 bg-accent/[0.12] text-accent' : 'border-white/[0.10] text-ink-300 hover:text-ink-100'}`}>
          <input type="checkbox" checked={viewed} onChange={(event) => onViewed(file.path, event.target.checked)} className="size-3.5 accent-[#8b97ff]" />
          Viewed
        </label>
      </header>
      {folded && large && (
        <div className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] text-ink-400">
          <span>
            Large diff: {(file.additions + file.deletions).toLocaleString()} changed lines.
          </span>
          <button type="button" onClick={() => onFold(file.path)} className="h-7 rounded-full bg-white/[0.08] px-3 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.14]">
            Load diff
          </button>
        </div>
      )}
      {!folded &&
        (error !== null ? (
          <div className="space-y-2 px-4 py-3">
            <ErrorNote error={error} />
            <button type="button" onClick={() => onRetry(file.path)} className="rounded-full bg-white/[0.08] px-3 py-1 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Try again
            </button>
          </div>
        ) : patched === undefined ? (
          <div style={{ height: estimateHeight(file, false) - headerHeight }} className="flex items-start gap-2 px-4 py-3 text-[12.5px] text-ink-500">
            <Spinner />
            Loading the diff
          </div>
        ) : patched.patch === null ? (
          <p className="px-4 py-3 text-[12.5px] text-ink-400 italic">GitHub shows no diff for this file (binary, or too large).</p>
        ) : (
          <DiffBody file={patched} scroller={scroller} offset={start + headerHeight} review={review} />
        ))}
    </section>
  )
})

export function PullRequestFiles({ files, review }: { files: Files; review: ReviewContext }) {
  const { controls } = review
  const [query, setQuery] = useState('')
  const [hideViewed, setHideViewed] = useState(false)
  // A file's fold, once the person changed it; otherwise large and removed files start folded.
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [navScroller, setNavScroller] = useState<HTMLUListElement | null>(null)
  const { pages } = files
  const { marks } = files
  const filtering = query.trim() !== '' || hideViewed
  const shown = useMemo(() => shownFiles(pages.files, query, hideViewed, marks), [pages.files, query, hideViewed, marks])
  const foldedOf = (file: GithubPullRequestFile) => folds[file.path] ?? startsFolded(file, isViewed(file, marks))
  const latest = useRef({ shown, foldedOf })
  latest.current = { shown, foldedOf }
  // Stable, so a file's section re-renders only when its own data changes, not on every scroll.
  const toggleFold = useCallback((path: string) => {
    const file = latest.current.shown.find((entry) => entry.path === path)
    if (file !== undefined) setFolds((current) => ({ ...current, [path]: !latest.current.foldedOf(file) }))
  }, [])
  // Marking a file viewed folds it, as on GitHub; clearing the mark opens it again.
  const { setViewed } = files
  const markViewed = useCallback(
    (path: string, viewed: boolean) => {
      setViewed(path, viewed)
      setFolds((current) => ({ ...current, [path]: viewed }))
    },
    [setViewed],
  )

  const diffs = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => {
      const file = shown[index]
      return file === undefined ? headerHeight : estimateHeight(file, foldedOf(file))
    },
    getItemKey: (index) => shown[index]?.path ?? index,
    gap: fileGap,
    paddingStart: 16,
    paddingEnd: 16,
    overscan: 1,
  })
  const nav = useVirtualizer({
    count: shown.length,
    getScrollElement: () => navScroller,
    estimateSize: () => navRowHeight,
    getItemKey: (index) => shown[index]?.path ?? index,
    overscan: 10,
  })

  // The files on screen and a couple either side get their diffs; the rest may be released.
  const visible = diffs.range === null ? null : { start: diffs.range.startIndex, end: diffs.range.endIndex }
  const near = diffWindow(visible, shown.length)
  const nearKey = near === null ? '' : `${near.start}:${near.end}`
  const navEnd = nav.range?.endIndex ?? 0
  useEffect(() => {
    if (near === null) return
    const onScreen = shown.slice(near.start, near.end + 1)
    const folded = new Set(onScreen.filter(foldedOf).map((file) => file.path))
    files.showDiffs(
      filesToFetch(shown, near, files.known, folded),
      onScreen.map((file) => file.path),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearKey, shown, folds])
  useEffect(() => {
    files.needPage(Math.max(navEnd, near?.end ?? 0), filtering)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navEnd, nearKey, filtering, pages])

  // A jump from the Threads tab: open the file and scroll to it; its diff then centres the line.
  // A file on a page not read yet makes the list read on until it shows up.
  const focusPath = review.focus?.path ?? null
  useEffect(() => {
    if (focusPath === null) return
    const index = shown.findIndex((file) => file.path === focusPath)
    if (index < 0) {
      if (pages.done) review.onFocused()
      else files.needPage(pages.files.length, true)
      return
    }
    setFolds((current) => ({ ...current, [focusPath]: false }))
    requestAnimationFrame(() => diffs.scrollToIndex(index, { align: 'start' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPath, shown, pages])

  if (pages.pages === 0) {
    return files.pagesError !== null ? (
      <div className="space-y-3 px-8 py-6">
        <ErrorNote error={files.pagesError} />
        <button type="button" onClick={files.reload} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
          Try again
        </button>
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 gap-4 px-8 py-5">
        <RowsSkeleton count={6} label="Reading the changed files" className="w-[260px] shrink-0" />
        <div className="min-w-0 flex-1">
          <CodeSkeleton />
        </div>
      </div>
    )
  }

  const total = pages.total ?? pages.files.length
  const reveal = (index: number) => {
    const file = shown[index]
    if (file === undefined) return
    setFolds((current) => ({ ...current, [file.path]: false }))
    requestAnimationFrame(() => diffs.scrollToIndex(index, { align: 'start' }))
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Changed files" className="flex w-[280px] shrink-0 flex-col border-r border-white/[0.06]">
        <div className="space-y-2 px-4 pt-4 pb-2">
          <p className="flex items-center gap-2 text-[12px] text-ink-400">
            {total.toLocaleString()} {total === 1 ? 'file' : 'files'}
            {pages.files.length < total && <span className="text-ink-500">· {pages.files.length.toLocaleString()} listed</span>}
            {pages.loading && <Spinner />}
          </p>
          <div className="flex items-center gap-2 text-[12px] text-ink-400">
            <span className="tabular-nums">
              {viewedCount(pages.files, marks)} / {total.toLocaleString()} viewed
            </span>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 hover:text-ink-200">
              <input type="checkbox" checked={hideViewed} onChange={(event) => setHideViewed(event.target.checked)} className="size-3.5 accent-[#8b97ff]" />
              Hide viewed
            </label>
          </div>
          {files.viewedError !== null && <ErrorNote error={files.viewedError} />}
          <input
            type="search"
            value={query}
            placeholder="Filter files"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            className="h-8 w-full rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60"
          />
        </div>
        {files.pagesError !== null && (
          <div className="space-y-2 px-4 pb-2">
            <ErrorNote error={files.pagesError} />
            <button type="button" onClick={() => files.needPage(pages.files.length, true)} className="rounded-full bg-white/[0.08] px-3 py-1 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Try again
            </button>
          </div>
        )}
        <ul ref={setNavScroller} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <li aria-hidden="true" style={{ height: nav.getTotalSize() }} className="pointer-events-none" />
          {nav.getVirtualItems().map((item) => {
            const file = shown[item.index]
            if (file === undefined) return null
            const tone = statusTone[file.status]
            const name = file.path.split('/').at(-1) ?? file.path
            const pending = controls.pending.filter((comment) => comment.path === file.path).length
            const seen = isViewed(file, marks)
            return (
              <li key={item.key} style={{ transform: `translateY(${item.start}px)`, height: navRowHeight }} className="absolute top-0 right-2 left-2">
                <button
                  type="button"
                  title={file.path}
                  onClick={() => reveal(item.index)}
                  className="grid h-full w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] px-2 text-left hover:bg-white/[0.05]"
                >
                  <span className={`w-3 font-mono text-[11px] font-bold ${tone.className}`}>{tone.letter}</span>
                  <span className={`min-w-0 ${seen ? 'opacity-50' : ''}`}>
                    <span className="block truncate text-[12.5px] text-ink-100">{name}</span>
                    <span className="block truncate text-[11px] text-ink-500">{file.path.slice(0, Math.max(0, file.path.length - name.length - 1))}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {pending > 0 && <span className="text-[11px] font-semibold text-warn">{pending}</span>}
                    <LineCounts additions={file.additions} deletions={file.deletions} />
                  </span>
                </button>
              </li>
            )
          })}
          {shown.length === 0 && !pages.loading && <li className="px-2 py-3 text-[12.5px] text-ink-500">{pages.files.length === 0 ? 'No files changed.' : hideViewed && query.trim() === '' ? 'Every file is viewed.' : 'No file matches.'}</li>}
        </ul>
      </nav>
      <div ref={setScroller} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-5">
        <div style={{ height: diffs.getTotalSize() }} />
        {diffs.getVirtualItems().map((item) => {
          const file = shown[item.index]
          if (file === undefined) return null
          return (
            // Placed with top, not a transform: a transform would shift the sticky file header off the top.
            <div key={item.key} ref={diffs.measureElement} data-index={item.index} style={{ top: item.start }} className="absolute right-5 left-5">
              <FileSection
                file={file}
                patched={files.patchOf(file.path)}
                error={files.diffError(file.path)}
                folded={foldedOf(file)}
                onFold={toggleFold}
                onRetry={files.retryDiff}
                scroller={scroller}
                start={item.start}
                viewed={isViewed(file, marks)}
                onViewed={markViewed}
                review={review}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
