import { useContext, useMemo, useState } from 'react'
import { clipRows, collapseContext, type EditRow, type FileEdit } from '@/chat/edit-diff'
import { PathLinksContext } from '@/chat/path-links'
import { firstPath } from '@/code/chat-paths'
import { lineTone, markers } from '@/github/diff-tones'
import { LineCounts } from '@/github/parts'
import type { DiffLine } from '@/github/review-model'

// What an edit call changed, under its row: per file, its name (opening it in Code), the lines added
// and removed, and the diff with long unchanged runs folded and very long diffs clipped. A failed
// edit's diff reads greyed: it shows what was attempted, not what the file holds.

const fileName = (path: string) =>
  path
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .at(-1) ?? path

function Line({ line, numbered }: { line: DiffLine; numbered: boolean }) {
  if (line.kind === 'hunk' || line.kind === 'note') {
    return <div className={`px-3 whitespace-pre ${lineTone[line.kind]}`}>{line.kind === 'hunk' && (line.text === '' || line.text === '@@') ? '⋯' : line.text}</div>
  }
  const number = (value: number | null) => <span className="w-[40px] shrink-0 border-r border-white/[0.04] px-2 text-right text-ink-600 tabular-nums select-none">{value ?? ''}</span>
  return (
    <div className={`flex w-max min-w-full ${lineTone[line.kind]}`}>
      {numbered && number(line.oldLine)}
      {numbered && number(line.newLine)}
      <span className="pr-4 pl-1.5 whitespace-pre text-ink-100 select-text">
        <span className="inline-block w-4 text-ink-500 select-none">{markers[line.kind]}</span>
        {line.text}
      </span>
    </div>
  )
}

function FileDiff({ file, failed }: { file: FileEdit; failed: boolean }) {
  const links = useContext(PathLinksContext)
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const [full, setFull] = useState(false)
  const rows = useMemo(() => collapseContext(file.lines), [file.lines])
  const clip = clipRows(rows)
  const shown = full ? rows : clip.shown
  const numbered = file.lines.some((line) => line.oldLine !== null || line.newLine !== null)
  // A patch names paths from the worktree; a Claude call names them absolute.
  const target = links?.root === null || links === null ? null : firstPath(file.path.startsWith('/') ? file.path : `${links.root.replace(/\/+$/, '')}/${file.path}`, links.root)
  const name = fileName(file.path)
  const row = (entry: EditRow, index: number) => {
    if (entry.kind !== 'skip') return <Line key={index} line={entry} numbered={numbered} />
    if (opened.has(index)) return entry.lines.map((line, at) => <Line key={`${index}:${at}`} line={line} numbered={numbered} />)
    return (
      <button
        key={index}
        type="button"
        onClick={() => setOpened((previous) => new Set(previous).add(index))}
        className="block w-full bg-white/[0.02] px-3 text-left text-ink-500 hover:bg-white/[0.05] hover:text-ink-300"
      >
        ⋯ {entry.lines.length} unchanged {entry.lines.length === 1 ? 'line' : 'lines'}
      </button>
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-1.5 text-[12px]">
        {target === null ? (
          <span title={file.path} className="min-w-0 truncate font-mono text-ink-200">
            {name}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => links?.open(target.path, null)}
            title={`Open in Code: ${target.text}`}
            className="min-w-0 truncate font-mono text-ink-200 hover:text-accent hover:underline"
          >
            {name}
          </button>
        )}
        {file.status !== 'modified' && <span className="shrink-0 text-ink-500">{file.status === 'added' ? 'new file' : 'deleted'}</span>}
        <span className={`ml-auto flex shrink-0 pl-2 ${failed ? 'opacity-50 grayscale' : ''}`}>
          <LineCounts additions={file.added} deletions={file.removed} />
        </span>
      </div>
      {rows.length > 0 && <div className={`overflow-x-auto py-1 font-mono text-[12px] leading-[18px] ${failed ? 'opacity-50 grayscale' : ''}`}>{shown.map(row)}</div>}
      {clip.hidden > 0 && (
        <button
          type="button"
          onClick={() => setFull((value) => !value)}
          className="w-full border-t border-white/[0.05] px-3 py-1.5 text-left text-[12px] text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
        >
          {full ? 'Show less' : `Show ${clip.hidden} more ${clip.hidden === 1 ? 'line' : 'lines'}`}
        </button>
      )}
    </div>
  )
}

export function EditDiff({ files, failed }: { files: FileEdit[]; failed: boolean }) {
  return (
    <div className="space-y-2">
      {files.map((file, index) => (
        <FileDiff key={`${file.path}:${index}`} file={file} failed={failed} />
      ))}
    </div>
  )
}
