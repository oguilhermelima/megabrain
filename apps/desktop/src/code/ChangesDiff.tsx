import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { BranchChanges, CodeChange } from '@/api/schema'
import { CodeSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { languageForPath, statusLetter } from '@/code/code-model'
import { CodeDiffEditor } from '@/code/editor'

type Section = 'uncommitted' | 'branch'

interface Selection {
  section: Section
  path: string
}

type DiffState =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'diff'; original: string; modified: string; language: string }

const statusColor: Record<CodeChange['status'], string> = {
  modified: 'text-warn',
  added: 'text-ok',
  deleted: 'text-bad',
  renamed: 'text-accent',
  untracked: 'text-ink-300',
}

/**
 * A worktree's changes in two lists, what is not committed yet and what the branch committed since
 * it left its base, with the selected file's diff beside them. The changes come from the caller,
 * which already polls them for the Diff badge; this reads only the selected file.
 */
export function ChangesDiff({ root, uncommitted, branch }: { root: string; uncommitted: readonly CodeChange[]; branch: BranchChanges | null }) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const mergeBase = branch?.mergeBase ?? null
  const committed = branch?.changes ?? []

  // The first file is open from the start; a selection whose file left its list moves to the first one again.
  const listed = (pick: Selection | null) => pick !== null && (pick.section === 'uncommitted' ? uncommitted : committed).some((change) => change.path === pick.path)
  const first: Selection | null = uncommitted[0] !== undefined ? { section: 'uncommitted', path: uncommitted[0].path } : committed[0] !== undefined ? { section: 'branch', path: committed[0].path } : null
  const shown = listed(selection) ? selection : first
  const shownStatus = shown === null ? null : ((shown.section === 'uncommitted' ? uncommitted : committed).find((change) => change.path === shown.path)?.status ?? null)

  useEffect(() => {
    if (shown === null) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiff({ kind: 'loading' })
    const read = shown.section === 'uncommitted' ? api.codeDiff(root, shown.path) : mergeBase === null ? null : api.codeBranchDiff(root, mergeBase, shown.path)
    if (read === null) return
    read
      .then((next) => {
        if (cancelled) return
        if (next.binary === true) setDiff({ kind: 'binary' })
        else if (next.tooLarge === true) setDiff({ kind: 'tooLarge' })
        else setDiff({ kind: 'diff', original: next.original, modified: next.modified, language: languageForPath(shown.path) })
      })
      .catch((error: unknown) => {
        if (!cancelled) setDiff({ kind: 'error', error })
      })
    return () => {
      cancelled = true
    }
    // The status is a dependency so a live change to the open file reloads it.
  }, [root, mergeBase, shown?.section, shown?.path, shownStatus])

  const list = (section: Section, changes: readonly CodeChange[]) =>
    changes.map((change) => {
      const selected = shown?.section === section && shown.path === change.path
      return (
        <button
          key={change.path}
          type="button"
          onClick={() => setSelection({ section, path: change.path })}
          aria-current={selected || undefined}
          title={change.path}
          className={`flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-[13px] ${selected ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-100'}`}
        >
          <span className={`w-4 shrink-0 text-center text-[12px] font-bold ${statusColor[change.status]}`}>{statusLetter(change.status)}</span>
          <span className="truncate">{change.path}</span>
        </button>
      )
    })

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Changed files" className="flex w-[300px] min-w-[240px] shrink-0 flex-col overflow-auto border-r border-white/[0.08] py-2">
        <SectionTitle title="Uncommitted" count={uncommitted.length} />
        {uncommitted.length === 0 ? <p className="px-3 pb-2 text-[13px] text-ink-500">Nothing uncommitted.</p> : list('uncommitted', uncommitted)}
        <SectionTitle title={branch?.base === null || branch?.base === undefined ? 'Committed on this branch' : `Committed on this branch (vs ${branch.base})`} count={committed.length} />
        {branch?.base === null ? (
          <p className="px-3 pb-2 text-[13px] text-ink-500">No base branch to compare with.</p>
        ) : committed.length === 0 ? (
          <p className="px-3 pb-2 text-[13px] text-ink-500">Nothing committed on this branch.</p>
        ) : (
          list('branch', committed)
        )}
      </aside>
      <main className="min-h-0 min-w-0 flex-1">{diffBody(diff)}</main>
    </div>
  )
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="flex items-center gap-2 px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.04em] text-ink-400 uppercase">
      <span className="truncate">{title}</span>
      {count > 0 && <span className="rounded-full bg-white/[0.1] px-1.5 text-[11px] text-ink-200 tabular-nums">{count}</span>}
    </h3>
  )
}

const note = (text: string) => <div className="flex h-full items-center justify-center text-[13px] text-ink-500">{text}</div>

function diffBody(diff: DiffState | null) {
  if (diff === null) return note('No changes.')
  switch (diff.kind) {
    case 'loading':
      return <CodeSkeleton />
    case 'error':
      return (
        <div className="p-6">
          <ErrorNote error={diff.error} />
        </div>
      )
    case 'binary':
      return note('Binary file — preview not available.')
    case 'tooLarge':
      return note('File too large to preview.')
    case 'diff':
      return <CodeDiffEditor original={diff.original} modified={diff.modified} language={diff.language} />
  }
}
