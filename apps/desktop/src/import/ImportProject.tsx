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
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-400">{path ?? 'No folder chosen'}</span>
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
                className={`w-full rounded-xl px-3 py-2 text-left text-[13.5px] ${chosen === repository.url ? 'bg-accent/15 text-ink-100' : 'text-ink-300 hover:bg-white/[0.06]'}`}
              >
                {repository.nameWithOwner}
                {repository.description !== null && <span className="ml-2 truncate text-ink-400">{repository.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={chooseDestination} disabled={cloning}>
          Destination
        </Button>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-400">{destination ?? 'No folder chosen'}</span>
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
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-label="Import project">
      <div className="w-full max-w-lg rounded-[28px] border border-white/10 bg-ink-900 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-semibold text-ink-100">Import a project</h2>
          <button type="button" onClick={onClose} className="rounded-full px-2 py-1 text-ink-400 hover:text-ink-200">
            ✕
          </button>
        </div>
        <div className="mt-4">
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
