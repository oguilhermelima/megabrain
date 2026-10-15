import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { GithubRepository, Project } from '@/api/schema'
import { Button, ErrorNote, Segmented, Spinner } from '@/components/ui'
import { defaultDestination, parseGithubSource } from '@/import/import-model'

type Tab = 'local' | 'github'

function LocalFolderTab({ onImported }: { onImported: () => void }) {
  const [path, setPath] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = () => {
    void api.pickFolder().then((selected) => {
      if (selected !== null) setPath(selected)
    })
  }

  const doImport = () => {
    if (path === null) return
    setImporting(true)
    setError(null)
    api.importFolder(path).then(
      () => onImported(),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    ).finally(() => setImporting(false))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button onClick={choose} disabled={importing}>
          Choose folder
        </Button>
        <span title={path ?? undefined} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-300">{path ?? 'No folder chosen'}</span>
      </div>
      {error !== null && <ErrorNote error={error} />}
      <div className="flex justify-end">
        <Button variant="primary" onClick={doImport} disabled={path === null || importing}>
          {importing ? <Spinner /> : 'Import'}
        </Button>
      </div>
    </div>
  )
}

function GithubTab({ projects, onImported }: { projects: Project[]; onImported: () => void }) {
  const [repositories, setRepositories] = useState<GithubRepository[] | null>(null)
  const [repositoriesError, setRepositoriesError] = useState<unknown>(null)
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [destination, setDestination] = useState<string | null>(defaultDestination(projects))
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.githubRepositories().then(setRepositories, setRepositoriesError)
  }, [])

  const filtered = (repositories ?? []).filter((repository) => repository.nameWithOwner.toLowerCase().includes(query.toLowerCase()))
  const source = chosen ?? query
  const chooseDestination = () => {
    void api.pickFolder().then((selected) => {
      if (selected !== null) setDestination(selected)
    })
  }

  const doClone = () => {
    const parsed = parseGithubSource(source)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    if (destination === null) {
      setError('Choose a destination folder.')
      return
    }
    setCloning(true)
    setError(null)
    api.importClone(parsed.url, destination).then(
      () => onImported(),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    ).finally(() => setCloning(false))
  }

  return (
    <div className="space-y-4">
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setChosen(null)
        }}
        autoFocus
        placeholder="Search, paste a URL, or owner/name…"
        className="w-full rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 text-[14px] text-ink-100 outline-none placeholder:text-ink-400"
      />
      {repositoriesError !== null && <ErrorNote error={repositoriesError} />}
      {repositories !== null && query !== '' && filtered.length > 0 && (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {filtered.map((repository) => (
            <li key={repository.nameWithOwner}>
              <button
                type="button"
                onClick={() => {
                  setChosen(repository.url)
                  setQuery(repository.nameWithOwner)
                }}
                title={repository.description ?? repository.nameWithOwner}
                className={`block w-full rounded-[14px] px-3 py-2 text-left text-[13.5px] ${chosen === repository.url ? 'bg-accent/[0.18] text-ink-100' : 'text-ink-200 hover:bg-white/[0.06]'}`}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{repository.nameWithOwner}</span>
                  {repository.isPrivate && <span className="shrink-0 rounded-[7px] border border-white/[0.16] px-1.5 text-[11px] leading-[18px] text-ink-300">private</span>}
                </span>
                {repository.description !== null && <span className="block truncate text-[12.5px] text-ink-400">{repository.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={chooseDestination} disabled={cloning}>
          Destination
        </Button>
        <span title={destination ?? undefined} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-300">{destination ?? 'No folder chosen'}</span>
      </div>
      {error !== null && <ErrorNote error={error} />}
      <div className="flex justify-end">
        <Button variant="primary" onClick={doClone} disabled={source.trim() === '' || cloning}>
          {cloning ? <Spinner /> : 'Clone'}
        </Button>
      </div>
    </div>
  )
}

export function ImportProject({ projects, onClose, onImported }: { projects: Project[]; onClose: () => void; onImported: () => void }) {
  const [tab, setTab] = useState<Tab>('local')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Import project"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="glass w-full max-w-lg rounded-[32px] border border-white/[0.1] p-7 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink-100">Import a project</h2>
            <p className="mt-1 text-[13.5px] text-ink-400">Add a repository from this Mac, or clone one from GitHub.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.1] hover:text-ink-100"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="mt-5">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'local', label: 'Local folder' },
              { value: 'github', label: 'GitHub' },
            ]}
          />
        </div>
        <div className="mt-5">
          {tab === 'local' ? <LocalFolderTab onImported={onImported} /> : <GithubTab projects={projects} onImported={onImported} />}
        </div>
      </div>
    </div>
  )
}
