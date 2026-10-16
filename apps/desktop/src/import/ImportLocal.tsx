import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { DiscoveredRepository, Project, ProjectScripts } from '@/api/schema'
import { tintSwatches } from '@/advanced/appearance-model'
import { Checkbox } from '@/components/Checkbox'
import { Bone } from '@/components/Skeleton'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { moveFocus, previewFromPath, previewPatch, remoteLabel, scriptLines, settleImports, toggleChoice, visibleSuggestions, type ImportPreview } from '@/import/import-model'
import { ago, BranchIcon, Chip, FolderIcon, KeyHint, RepoMark, SearchField, tildePath } from '@/import/parts'
import { insideModal, useWindowDrop } from '@/lib/window-drop'

type Scan = { state: 'loading' } | { state: 'stopped' } | { state: 'error'; error: unknown } | { state: 'done'; found: DiscoveredRepository[] }

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))

/** The folders `repo discover` looks in by default, for the loading and empty states. */
const searchedRoots = '~/Workspaces, ~/Developer, ~/Projects, ~/code, ~/src and beside your projects'

/** One scan per dialog; Rescan starts another and the answer to an older one is dropped. */
function useScan(): [Scan, () => void, () => void] {
  const [scan, setScan] = useState<Scan>({ state: 'loading' })
  const [round, setRound] = useState(0)
  const live = useRef(0)
  useEffect(() => {
    const seq = ++live.current
    setScan({ state: 'loading' })
    api.discoverRepositories().then(
      (found) => seq === live.current && setScan({ state: 'done', found }),
      (error: unknown) => seq === live.current && setScan({ state: 'error', error }),
    )
  }, [round])
  const rescan = () => setRound((value) => value + 1)
  const stop = () => {
    live.current += 1
    setScan({ state: 'stopped' })
  }
  return [scan, rescan, stop]
}

export function LocalTab({ projects, home, onImported, onBack }: { projects: Project[]; home: string | null; onImported: () => void; onBack: (back: (() => void) | null) => void }) {
  const [scan, rescan, stopScan] = useScan()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [focus, setFocus] = useState(-1)
  const [imported, setImported] = useState<string[]>([])
  const [busy, setBusy] = useState<string[]>([])
  const [failures, setFailures] = useState<{ path: string; error: string }[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [hovering, setHovering] = useState(false)
  const rows = useRef<(HTMLLIElement | null)[]>([])
  const search = useRef<HTMLInputElement>(null)

  const found = scan.state === 'done' ? scan.found : []
  const registered = [...projects.map((project) => project.path), ...imported]
  const visible = visibleSuggestions(found, registered, query)
  const focused = moveFocus(focus, 0, visible.length)

  useEffect(() => {
    onBack(preview === null ? null : () => setPreview(null))
  }, [preview, onBack])

  const open = (path: string) => {
    setFailures([])
    setPreview(previewFromPath(path, found))
  }

  /** Imports folders side by side; the dialog closes once all made it, else the failures stay listed. */
  const importPaths = async (paths: string[]) => {
    if (paths.length === 0) return
    setBusy((current) => [...current, ...paths])
    setFailures([])
    const results = await Promise.allSettled(paths.map((path) => api.importFolder(path)))
    const outcome = settleImports(paths, results)
    setBusy((current) => current.filter((path) => !paths.includes(path)))
    setImported((current) => [...current, ...outcome.imported])
    setChosen((current) => current.filter((path) => !outcome.imported.includes(path)))
    setFailures(outcome.failed)
    if (outcome.failed.length === 0) onImported()
  }

  const choose = () => {
    void api.pickFolder(home === null ? undefined : `${home}/Workspaces`).then((selected) => {
      if (selected !== null) open(selected)
    })
  }

  useWindowDrop(
    {
      onDrop: (paths, x, y) => {
        if (preview !== null || !insideModal(x, y)) return
        if (paths.length === 1 && paths[0] !== undefined) open(paths[0])
        else void importPaths(paths)
      },
      onHover: setHovering,
    },
    true,
  )

  if (preview !== null) {
    return <PreviewCard key={preview.path} initial={preview} home={home} onBack={() => setPreview(null)} onImported={onImported} />
  }

  const onListKey = (event: KeyboardEvent) => {
    const entry = visible[focused]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = moveFocus(focused, event.key === 'ArrowDown' ? 1 : -1, visible.length)
      if (event.key === 'ArrowUp' && focused === 0) {
        setFocus(-1)
        search.current?.focus()
        return
      }
      setFocus(next)
      rows.current[next]?.focus()
    } else if (event.key === ' ' && entry !== undefined && event.target === rows.current[focused]) {
      event.preventDefault()
      setChosen((current) => toggleChoice(current, entry.path))
    } else if (event.key === 'Enter' && entry !== undefined && event.target === rows.current[focused]) {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) void importPaths(chosen.length > 0 ? chosen : [entry.path])
      else open(entry.path)
    }
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visible.length > 0) {
      event.preventDefault()
      setFocus(0)
      rows.current[0]?.focus()
    } else if (event.key === 'Enter' && visible[0] !== undefined) {
      event.preventDefault()
      open(visible[0].path)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-7 pb-6">
        <div className={`flex items-center gap-5 rounded-[24px] border-2 border-dashed px-6 py-5 transition-colors duration-150 motion-reduce:transition-none ${hovering ? 'border-accent/70 bg-accent/[0.08]' : 'border-white/[0.12] bg-white/[0.02]'}`}>
          <span className={`grid size-12 shrink-0 place-items-center rounded-[14px] ${hovering ? 'bg-accent/20 text-accent' : 'bg-white/[0.06] text-ink-300'}`}>
            <FolderIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold text-ink-100">{hovering ? 'Drop to import' : 'Drop a folder here'}</p>
            <p className="mt-0.5 text-[13px] text-ink-400">Drag a repository from Finder, or choose one. Several folders at once import together.</p>
          </div>
          <Button onClick={choose}>Choose folder…</Button>
        </div>

        <section aria-labelledby="import-found" className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 id="import-found" className="text-[12px] font-semibold tracking-[0.06em] text-ink-400 uppercase">
              Found on this Mac
              {scan.state === 'done' && <span className="ml-2 font-normal tracking-normal text-ink-500 normal-case">{visible.length === found.length ? found.length : `${visible.length} of ${found.length}`}</span>}
            </h3>
            <span className="flex-1" />
            {scan.state === 'loading' ? (
              <Button variant="ghost" className="h-8 px-3 text-[12.5px]" onClick={stopScan}>
                Stop
              </Button>
            ) : (
              <Button variant="ghost" className="h-8 px-3 text-[12.5px]" onClick={rescan}>
                Scan again
              </Button>
            )}
          </div>
          {(scan.state === 'done' && found.length > 0) && (
            <SearchField inputRef={search} value={query} onChange={setQuery} onKeyDown={onSearchKey} label="Filter the repositories found" placeholder="Filter by name, folder or remote…" autoFocus />
          )}
          {scan.state === 'loading' && <ScanSkeleton />}
          {scan.state === 'stopped' && <p className="rounded-[18px] bg-white/[0.03] px-4 py-6 text-center text-[13px] text-ink-400">Scan stopped. Choose a folder, or scan again.</p>}
          {scan.state === 'error' && (
            <div className="space-y-2">
              <ErrorNote error={scan.error} />
              <p className="text-[12.5px] text-ink-500">You can still choose a folder or drop one above.</p>
            </div>
          )}
          {scan.state === 'done' && found.length === 0 && (
            <div className="rounded-[18px] bg-white/[0.03] px-4 py-8 text-center">
              <p className="text-[13.5px] text-ink-200">No new repositories found</p>
              <p className="mt-1 text-[12.5px] text-ink-500">Looked in {searchedRoots}. Everything there is already a project.</p>
            </div>
          )}
          {scan.state === 'done' && found.length > 0 && visible.length === 0 && <p className="px-1 py-4 text-[13px] text-ink-400">Nothing matches “{query.trim()}”.</p>}
          {visible.length > 0 && (
            <ul role="listbox" aria-label="Repositories found" aria-multiselectable="true" onKeyDown={onListKey} className="space-y-1">
              {visible.map((entry, index) => (
                <SuggestionRow
                  key={entry.path}
                  entry={entry}
                  home={home}
                  focused={index === focused}
                  chosen={chosen.includes(entry.path)}
                  busy={busy.includes(entry.path)}
                  rowRef={(node) => {
                    rows.current[index] = node
                  }}
                  onFocus={() => setFocus(index)}
                  onToggle={() => setChosen((current) => toggleChoice(current, entry.path))}
                  onOpen={() => open(entry.path)}
                  onImport={() => void importPaths([entry.path])}
                />
              ))}
            </ul>
          )}
          {failures.length > 0 && (
            <div className="space-y-2" role="alert">
              {failures.map((failure) => (
                <ErrorNote key={failure.path} error={`${tildePath(failure.path, home)}: ${failure.error}`} />
              ))}
            </div>
          )}
        </section>
      </div>
      <footer className="flex min-h-[64px] items-center gap-3 border-t border-white/[0.08] px-7 py-3">
        {chosen.length > 0 ? (
          <>
            <span className="text-[13px] text-ink-200">{chosen.length} selected</span>
            <Button variant="ghost" className="h-8 px-3 text-[12.5px]" onClick={() => setChosen([])}>
              Clear
            </Button>
          </>
        ) : (
          <span className="flex flex-wrap items-center gap-4">
            <KeyHint keys="↑↓">move</KeyHint>
            <KeyHint keys="Space">select</KeyHint>
            <KeyHint keys="Enter">review</KeyHint>
            <KeyHint keys="⌘Enter">import</KeyHint>
          </span>
        )}
        <span className="flex-1" />
        <Button variant="primary" onClick={() => void importPaths(chosen)} disabled={chosen.length === 0 || busy.length > 0}>
          {busy.length > 0 ? <Spinner /> : chosen.length > 1 ? `Import ${chosen.length} projects` : 'Import'}
        </Button>
      </footer>
    </div>
  )
}

function ScanSkeleton() {
  return (
    <div role="status" aria-label="Looking for repositories" className="space-y-1">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3 rounded-[16px] px-3 py-2.5">
          <span className="size-4 shrink-0" />
          <span className="size-8 shrink-0 animate-pulse rounded-[10px] bg-white/[0.06] motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Bone width={`${34 - row * 4}%`} />
            <Bone width={`${58 - row * 6}%`} className="h-2.5" />
          </div>
        </div>
      ))}
      <p className="px-3 pt-1 text-[12.5px] text-ink-500">Looking in {searchedRoots}…</p>
    </div>
  )
}

function SuggestionRow({
  entry,
  home,
  focused,
  chosen,
  busy,
  rowRef,
  onFocus,
  onToggle,
  onOpen,
  onImport,
}: {
  entry: DiscoveredRepository
  home: string | null
  focused: boolean
  chosen: boolean
  busy: boolean
  rowRef: (node: HTMLLIElement | null) => void
  onFocus: () => void
  onToggle: () => void
  onOpen: () => void
  onImport: () => void
}) {
  const remote = remoteLabel(entry.remote)
  return (
    <li
      ref={rowRef}
      role="option"
      aria-selected={chosen}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
      className={`group flex cursor-pointer items-center gap-3 rounded-[16px] px-3 py-2.5 outline-none ${chosen ? 'bg-accent/[0.12]' : 'hover:bg-white/[0.05]'} focus-visible:ring-2 focus-visible:ring-accent/60`}
    >
      <span onClick={(event) => event.stopPropagation()} className="flex">
        <Checkbox checked={chosen} onChange={onToggle}>
          <span className="sr-only">Select {entry.name}</span>
        </Checkbox>
      </span>
      <RepoMark name={entry.name} remote={entry.remote} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink-100">{entry.name}</span>
          {entry.branch !== null && (
            <Chip title={`On ${entry.branch}`}>
              <BranchIcon />
              <span className="truncate">{entry.branch}</span>
            </Chip>
          )}
          {remote !== null && <span className="hidden truncate text-[12.5px] text-ink-400 sm:inline">{remote}</span>}
        </div>
        <p title={entry.path} className="truncate font-mono text-[11.5px] text-ink-500">
          {tildePath(entry.path, home)}
        </p>
      </div>
      <span className="hidden shrink-0 text-[12px] text-ink-500 md:inline" title={entry.lastCommitAt ?? 'No commits yet'}>
        {entry.lastCommitAt === null ? 'no commits' : ago(entry.lastCommitAt)}
      </span>
      <Button
        variant="secondary"
        tabIndex={-1}
        className={`h-8 shrink-0 px-3.5 text-[12.5px] ${busy ? '' : 'opacity-0 group-hover:opacity-100 group-focus:opacity-100'}`}
        aria-label={`Import ${entry.name}`}
        onClick={(event) => {
          event.stopPropagation()
          onImport()
        }}
        disabled={busy}
      >
        {busy ? <Spinner /> : 'Import'}
      </Button>
    </li>
  )
}

const swatch = 'grid size-6 shrink-0 place-items-center rounded-full ring-offset-2 ring-offset-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40'

/**
 * The folder the person chose, dressed before it is imported: the name and colour megabrain shows,
 * a picture, and what megabrain detected (branch, remote, scripts). Nothing is saved until Import.
 */
function PreviewCard({ initial, home, onBack, onImported }: { initial: ImportPreview; home: string | null; onBack: () => void; onImported: () => void }) {
  const [preview, setPreview] = useState(initial)
  const [scripts, setScripts] = useState<ProjectScripts | null | 'loading' | 'error'>('loading')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const importButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let stopped = false
    api.projectScripts(initial.path).then(
      (value) => !stopped && setScripts(value),
      () => !stopped && setScripts('error'),
    )
    importButton.current?.focus()
    return () => {
      stopped = true
    }
  }, [initial.path])

  const update = (patch: Partial<ImportPreview>) => setPreview((current) => ({ ...current, ...patch }))

  const choosePicture = () => {
    void api.pickImage().then((path) => path !== null && update({ picture: path }), (caught: unknown) => setError(message(caught)))
  }

  const doImport = async () => {
    setImporting(true)
    setError(null)
    try {
      const repository = await api.importFolder(preview.path)
      const patch = previewPatch(preview)
      if (patch !== null) await api.setProjectAppearance(repository.path, patch)
      onImported()
    } catch (caught) {
      setError(message(caught))
      setImporting(false)
    }
  }

  const lines = scripts === 'loading' || scripts === 'error' ? [] : scriptLines(scripts)
  const remote = remoteLabel(preview.remote)
  const displayName = preview.name.trim() === '' ? preview.folderName : preview.name.trim()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
        <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] text-ink-400 hover:bg-white/[0.06] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30">
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3 5 8l5 5" />
          </svg>
          All suggestions
        </button>
        <section aria-label="Before importing" className="rounded-[24px] border border-white/[0.08] bg-ink-900 p-6">
          <header className="flex items-center gap-4">
            <button type="button" onClick={choosePicture} title="Choose a picture" aria-label={`Choose a picture for ${displayName}`} className="rounded-[16px] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
              <RepoMark name={displayName} remote={preview.remote} picture={preview.picture} color={preview.color} size="large" />
            </button>
            <div className="min-w-0 flex-1">
              <input
                value={preview.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={preview.folderName}
                aria-label="Display name"
                title="The name megabrain shows; the repository keeps its own."
                spellCheck={false}
                className="-mx-1.5 w-full truncate rounded-[8px] border border-transparent bg-transparent px-1.5 text-[19px] font-semibold tracking-[-0.01em] text-ink-100 placeholder:text-ink-500 hover:border-white/[0.08] focus:border-accent/60 focus:outline-none"
              />
              <p title={preview.path} className="truncate font-mono text-[12px] text-ink-500 select-text">
                {tildePath(preview.path, home)}
              </p>
            </div>
            {preview.picture !== null && (
              <Button variant="ghost" className="h-8 px-3 text-[12.5px]" onClick={() => update({ picture: null })}>
                Remove picture
              </Button>
            )}
          </header>
          <div className="mt-5 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Colour of the agent marks">
            <span className="mr-1 text-[12.5px] text-ink-400">Agent colour</span>
            <button type="button" role="radio" aria-checked={preview.color === null} aria-label="None" title="None: agents keep their own colours" onClick={() => update({ color: null })} className={`${swatch} border border-white/[0.2] text-ink-400 ${preview.color === null ? 'ring-2 ring-white/60' : ''}`}>
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M4 12 12 4" />
              </svg>
            </button>
            {tintSwatches.map((color) => (
              <button key={color} type="button" role="radio" aria-checked={preview.color === color} aria-label={color} title={color} onClick={() => update({ color })} style={{ backgroundColor: color }} className={`${swatch} ${preview.color === color ? 'ring-2 ring-white/60' : ''}`} />
            ))}
          </div>
          <dl className="mt-6 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 border-t border-white/[0.06] pt-5 text-[13px]">
            <dt className="text-ink-400">Branch</dt>
            <dd className="min-w-0 truncate text-ink-100">{preview.branch ?? <span className="text-ink-500">detected on import</span>}</dd>
            <dt className="text-ink-400">Remote</dt>
            <dd className="min-w-0 truncate text-ink-100" title={preview.remote ?? undefined}>
              {remote ?? <span className="text-ink-500">none</span>}
            </dd>
            <dt className="text-ink-400">Scripts</dt>
            <dd className="min-w-0">
              {scripts === 'loading' && <Bone width="60%" />}
              {scripts === 'error' && <span className="text-ink-500">could not read them; set them later in the project’s settings</span>}
              {scripts !== 'loading' && scripts !== 'error' && lines.length === 0 && <span className="text-ink-500">none detected; set them later in the project’s settings</span>}
              {lines.length > 0 && (
                <ul className="space-y-1.5">
                  {lines.map((line) => (
                    <li key={line.name} className="flex min-w-0 items-center gap-2">
                      <span className="w-12 shrink-0 text-[12px] text-ink-400 capitalize">{line.name}</span>
                      <code className="min-w-0 truncate rounded-lg bg-white/[0.06] px-2 py-0.5 font-mono text-[12px] text-ink-100" title={line.command}>
                        {line.command}
                      </code>
                      {line.source === 'saved' && <Chip>saved</Chip>}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </section>
        {error !== null && (
          <div className="mt-4" role="alert">
            <ErrorNote error={error} />
          </div>
        )}
      </div>
      <footer className="flex min-h-[64px] items-center gap-3 border-t border-white/[0.08] px-7 py-3">
        <KeyHint keys="Esc">back</KeyHint>
        <span className="flex-1" />
        <Button onClick={onBack} disabled={importing}>
          Back
        </Button>
        <Button ref={importButton} variant="primary" onClick={() => void doImport()} disabled={importing}>
          {importing ? <Spinner /> : `Import ${displayName}`}
        </Button>
      </footer>
    </div>
  )
}
