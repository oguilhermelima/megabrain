import { Fragment, memo, useMemo, useRef, useState } from 'react'
import type { GithubPullRequestFile } from '@/api/schema'
import { languageForPath } from '@/code/code-model'
import { CodeSkeleton, RowsSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { highlightLines } from '@/github/diff-highlight'
import { ChevronIcon, CommentIcon } from '@/github/icons'
import { LineCounts } from '@/github/parts'
import { commentTarget, fileTotals, filterFiles, parsePatch, pendingAt, type CommentTarget, type DiffLine, type PendingComment } from '@/github/review-model'

// A pull request's Files tab: the changed files with their counts and a filter on the left, and on
// the right each file's unified diff, syntax-coloured and collapsible. A click on a line's number
// opens a comment there; it stays pending, under its line, until the review is submitted.

const statusTone: Record<GithubPullRequestFile['status'], { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-ok' },
  modified: { letter: 'M', className: 'text-warn' },
  removed: { letter: 'D', className: 'text-bad' },
  renamed: { letter: 'R', className: 'text-accent' },
}

/** Files this long start folded, so a lockfile does not bury the rest. */
const foldAbove = 400

const lineTone: Record<DiffLine['kind'], string> = {
  add: 'bg-ok/[0.10]',
  del: 'bg-bad/[0.10]',
  context: '',
  hunk: 'bg-accent/[0.08] text-ink-400',
  note: 'text-ink-500 italic',
}

const markers: Record<DiffLine['kind'], string> = { add: '+', del: '-', context: ' ', hunk: '', note: '' }

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

const FileDiff = memo(function FileDiff({ file, controls, folded, onFold }: { file: GithubPullRequestFile; controls: PendingControls; folded: boolean; onFold: () => void }) {
  const lines = useMemo(() => parsePatch(file.patch), [file.patch])
  const spans = useMemo(() => (folded ? [] : highlightLines(lines.map((line) => line.text), languageForPath(file.path))), [folded, lines, file.path])
  const [drafting, setDrafting] = useState<string | null>(null)
  const pendingHere = controls.pending.filter((comment) => comment.path === file.path)
  const tone = statusTone[file.status]

  return (
    <section className="overflow-hidden rounded-[16px] border border-white/[0.08] bg-ink-950">
      <header className="sticky top-0 z-[1] flex items-center gap-2 border-b border-white/[0.06] bg-ink-900 px-3 py-2">
        <button type="button" onClick={onFold} aria-expanded={!folded} aria-label={folded ? `Show ${file.path}` : `Fold ${file.path}`} className="flex size-6 items-center justify-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
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
        {pendingHere.length > 0 && (
          <span className="flex items-center gap-1 text-[11.5px] font-semibold text-warn">
            <CommentIcon size={12} />
            {pendingHere.length}
          </span>
        )}
        <LineCounts additions={file.additions} deletions={file.deletions} />
      </header>
      {!folded &&
        (file.patch === null ? (
          <p className="px-4 py-3 text-[12.5px] text-ink-400 italic">GitHub shows no diff for this file (binary, or too large).</p>
        ) : (
          <div className="overflow-x-auto font-mono text-[12.5px] leading-[20px]">
            <table className="w-full border-collapse">
              <tbody>
                {lines.map((line, index) => {
                  const target = commentTarget(file.path, line)
                  const key = target === null ? null : targetKey(target)
                  const notes = target === null ? [] : pendingAt(controls.pending, target)
                  const number = (value: number | null) => (
                    <td className="w-[1%] min-w-[44px] border-r border-white/[0.04] px-2 text-right align-top text-ink-600 tabular-nums select-none">
                      {target === null ? (
                        value
                      ) : (
                        <button type="button" onClick={() => setDrafting(key)} title="Comment on this line" className="w-full text-right hover:text-accent">
                          {value ?? ''}
                        </button>
                      )}
                    </td>
                  )
                  return (
                    <Fragment key={index}>
                      <tr className={`group ${lineTone[line.kind]}`}>
                        {line.kind === 'hunk' || line.kind === 'note' ? (
                          <td colSpan={3} className="px-3 whitespace-pre text-[12px]">
                            {line.text}
                          </td>
                        ) : (
                          <>
                            {number(line.oldLine)}
                            {number(line.newLine)}
                            <td className="relative pr-4 pl-1 whitespace-pre text-ink-100 select-text">
                              <span className="inline-block w-4 text-ink-500 select-none">{markers[line.kind]}</span>
                              {(spans[index] ?? [{ text: line.text, className: '' }]).map((span, spanIndex) => (
                                <span key={spanIndex} className={span.className}>
                                  {span.text}
                                </span>
                              ))}
                            </td>
                          </>
                        )}
                      </tr>
                      {(notes.length > 0 || (key !== null && drafting === key)) && target !== null && (
                        <tr>
                          <td colSpan={3} className="space-y-2 border-y border-white/[0.06] bg-black/30 px-3 py-2">
                            {notes.map((comment) => (
                              <PendingNote key={comment.id} comment={comment} controls={controls} />
                            ))}
                            {drafting === key && (
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
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
})

export function PullRequestFiles({ files, error, onRetry, controls }: { files: GithubPullRequestFile[] | null; error: unknown; onRetry: () => void; controls: PendingControls }) {
  const [query, setQuery] = useState('')
  // A file's fold, once the person changed it; otherwise long and removed files start folded.
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const sections = useRef(new Map<string, HTMLElement>())
  const shown = useMemo(() => (files === null ? [] : filterFiles(files, query)), [files, query])

  if (files === null) {
    return error !== null ? (
      <div className="space-y-3 px-8 py-6">
        <ErrorNote error={error} />
        <button type="button" onClick={onRetry} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
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

  const totals = fileTotals(files)
  const foldedOf = (file: GithubPullRequestFile) => folds[file.path] ?? (file.status === 'removed' || parsePatch(file.patch).length > foldAbove)

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label="Changed files" className="flex w-[280px] shrink-0 flex-col border-r border-white/[0.06]">
        <div className="space-y-2 px-4 pt-4 pb-2">
          <p className="flex items-center gap-2 text-[12px] text-ink-400">
            {totals.files} {totals.files === 1 ? 'file' : 'files'}
            <LineCounts additions={totals.additions} deletions={totals.deletions} />
          </p>
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
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {shown.map((file) => {
            const tone = statusTone[file.status]
            const name = file.path.split('/').at(-1) ?? file.path
            const pending = controls.pending.filter((comment) => comment.path === file.path).length
            return (
              <li key={file.path}>
                <button
                  type="button"
                  title={file.path}
                  onClick={() => {
                    setFolds((current) => ({ ...current, [file.path]: false }))
                    requestAnimationFrame(() => sections.current.get(file.path)?.scrollIntoView({ block: 'start' }))
                  }}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] px-2 py-1.5 text-left hover:bg-white/[0.05]"
                >
                  <span className={`w-3 font-mono text-[11px] font-bold ${tone.className}`}>{tone.letter}</span>
                  <span className="min-w-0">
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
          {shown.length === 0 && <li className="px-2 py-3 text-[12.5px] text-ink-500">{files.length === 0 ? 'No files changed.' : 'No file matches.'}</li>}
        </ul>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {shown.map((file) => (
          <div
            key={file.path}
            ref={(element) => {
              if (element === null) sections.current.delete(file.path)
              else sections.current.set(file.path, element)
            }}
          >
            <FileDiff file={file} controls={controls} folded={foldedOf(file)} onFold={() => setFolds((current) => ({ ...current, [file.path]: !foldedOf(file) }))} />
          </div>
        ))}
      </div>
    </div>
  )
}
