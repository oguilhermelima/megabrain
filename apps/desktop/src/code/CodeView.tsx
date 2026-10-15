import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { CodeChange, CodeEntry } from '@/api/schema'
import { Button, ErrorNote, Spinner, type Tone } from '@/components/ui'
import { buildTree, languageForPath, matchingPaths, statusLetter } from '@/code/code-model'
import { CodeDiffEditor, CodeEditor } from '@/code/editor'
import { FileTree } from '@/code/file-tree'

type Tab = 'files' | 'changes'

interface Selection {
  path: string
  fromChanges: boolean
}

type FileState =
  | { kind: 'loading' }
  | { kind: 'error'; error: unknown }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'missing' }
  | { kind: 'text'; text: string; language: string }
  | { kind: 'diff'; original: string; modified: string; language: string }

const changeTone: Record<CodeChange['status'], Tone> = {
  modified: 'warn',
  added: 'ok',
  deleted: 'bad',
  renamed: 'accent',
  untracked: 'neutral',
}

export function CodeView({ root, title, onClose }: { root: string; title: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('files')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(null)

  const [entries, setEntries] = useState<CodeEntry[] | null>(null)
  const [treeError, setTreeError] = useState<unknown>(null)
  const [changes, setChanges] = useState<CodeChange[]>([])
  const [fileState, setFileState] = useState<FileState | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setTreeError(null)
    setSelection(null)
    setExpanded(new Set())
    setFilter('')
    api
      .codeTree(root)
      .then((next) => {
        if (!cancelled) setEntries(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setTreeError(error)
      })
    return () => {
      cancelled = true
    }
  }, [root])

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      api
        .codeChanges(root)
        .then((next) => {
          if (!cancelled) setChanges(next)
        })
        .catch(() => {
          // A transient poll failure keeps the last known changes rather than clearing the list.
        })
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [root])

  const selectedStatus = selection ? changes.find((change) => change.path === selection.path)?.status ?? null : null

  useEffect(() => {
    if (!selection) {
      setFileState(null)
      return
    }
    let cancelled = false
    setFileState({ kind: 'loading' })
    const language = languageForPath(selection.path)
    if (selection.fromChanges) {
      api
        .codeDiff(root, selection.path)
        .then((diff) => {
          if (cancelled) return
          if (diff.binary === true) setFileState({ kind: 'binary' })
          else if (diff.tooLarge === true) setFileState({ kind: 'tooLarge' })
          else setFileState({ kind: 'diff', original: diff.original, modified: diff.modified, language })
        })
        .catch((error: unknown) => {
          if (!cancelled) setFileState({ kind: 'error', error })
        })
    } else {
      api
        .codeRead(root, selection.path)
        .then((file) => {
          if (cancelled) return
          if (file.binary) setFileState({ kind: 'binary' })
          else if (file.tooLarge) setFileState({ kind: 'tooLarge' })
          else if (file.text === null) setFileState({ kind: 'missing' })
          else setFileState({ kind: 'text', text: file.text, language })
        })
        .catch((error: unknown) => {
          if (!cancelled) setFileState({ kind: 'error', error })
        })
    }
    return () => {
      cancelled = true
    }
    // selectedStatus is in the dependency list so a live change to the open file's status, or it
    // entering or leaving the changed set, reloads the content; the editors keep scroll position.
  }, [root, selection, selectedStatus])

  const tree = useMemo(() => (entries ? buildTree(entries) : []), [entries])
  const matches = useMemo(() => (entries ? matchingPaths(entries, filter) : new Set<string>()), [entries, filter])
  const filterActive = filter.trim() !== ''

  const toggleDir = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectFile = (path: string) => setSelection({ path, fromChanges: false })
  const selectChange = (path: string) => setSelection({ path, fromChanges: true })

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <header className="glass flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-ink-100">{title}</h2>
          <p className="truncate font-mono text-[12px] text-ink-400">{root}</p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] min-w-[300px] flex-col border-r border-white/[0.08]">
          <div className="flex border-b border-white/[0.08] px-2 pt-2">
            <button
              type="button"
              onClick={() => setTab('files')}
              className={`flex-1 rounded-t-lg px-3 py-2 text-[13px] font-semibold ${tab === 'files' ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}
            >
              Files
            </button>
            <button
              type="button"
              onClick={() => setTab('changes')}
              className={`flex flex-1 items-center justify-center gap-2 rounded-t-lg px-3 py-2 text-[13px] font-semibold ${tab === 'changes' ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}
            >
              Changes
              {changes.length > 0 && <span className="rounded-full bg-white/[0.1] px-1.5 py-0.5 text-[11px] text-ink-200">{changes.length}</span>}
            </button>
          </div>

          {tab === 'files' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="p-2">
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter files"
                  className="w-full rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {treeError !== null ? (
                  <div className="p-3">
                    <ErrorNote error={treeError} />
                  </div>
                ) : entries === null ? (
                  <div className="flex items-center gap-2 p-3 text-[13px] text-ink-400">
                    <Spinner /> Loading files…
                  </div>
                ) : tree.length === 0 ? (
                  <p className="p-3 text-[13px] text-ink-500">No files.</p>
                ) : (
                  <FileTree
                    nodes={tree}
                    filterActive={filterActive}
                    matches={matches}
                    expanded={expanded}
                    onToggleDir={toggleDir}
                    onSelectFile={selectFile}
                    selectedPath={selection?.fromChanges === false ? selection.path : null}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {changes.length === 0 ? (
                <p className="p-3 text-[13px] text-ink-500">No changes.</p>
              ) : (
                changes.map((change) => (
                  <button
                    key={change.path}
                    type="button"
                    onClick={() => selectChange(change.path)}
                    className={`flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-[13px] ${
                      selection?.fromChanges === true && selection.path === change.path
                        ? 'bg-white/[0.1] text-ink-100'
                        : 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-100'
                    }`}
                    title={change.path}
                  >
                    <span className={`w-4 shrink-0 text-center text-[12px] font-bold ${colorForTone(changeTone[change.status])}`}>{statusLetter(change.status)}</span>
                    <span className="truncate">{change.path}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <main className="min-h-0 min-w-0 flex-1">{renderFileState(fileState)}</main>
      </div>
    </div>
  )
}

function colorForTone(tone: Tone): string {
  switch (tone) {
    case 'ok':
      return 'text-ok'
    case 'warn':
      return 'text-warn'
    case 'bad':
      return 'text-bad'
    case 'accent':
      return 'text-accent'
    default:
      return 'text-ink-300'
  }
}

function renderFileState(fileState: FileState | null) {
  if (fileState === null) return <div className="flex h-full items-center justify-center text-[13px] text-ink-500">Select a file to view it.</div>
  switch (fileState.kind) {
    case 'loading':
      return (
        <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-400">
          <Spinner /> Loading…
        </div>
      )
    case 'error':
      return (
        <div className="p-6">
          <ErrorNote error={fileState.error} />
        </div>
      )
    case 'binary':
      return <div className="flex h-full items-center justify-center text-[13px] text-ink-500">Binary file — preview not available.</div>
    case 'tooLarge':
      return <div className="flex h-full items-center justify-center text-[13px] text-ink-500">File too large to preview.</div>
    case 'missing':
      return <div className="flex h-full items-center justify-center text-[13px] text-ink-500">File not found.</div>
    case 'text':
      return <CodeEditor text={fileState.text} language={fileState.language} />
    case 'diff':
      return <CodeDiffEditor original={fileState.original} modified={fileState.modified} language={fileState.language} />
  }
}
