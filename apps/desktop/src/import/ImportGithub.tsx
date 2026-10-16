import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { GithubOwner, GithubRepository, Project } from '@/api/schema'
import { Bone } from '@/components/Skeleton'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { cloneTarget, defaultDestination, isImportedGithub, moveFocus, parseGithubSource, visibleGithub } from '@/import/import-model'
import { ago, Chip, KeyHint, RepoMark, SearchField, StarIcon, tildePath } from '@/import/parts'

type Listing = { state: 'loading' } | { state: 'done'; owners: GithubOwner[]; repositories: GithubRepository[]; errors: string[] } | { state: 'error'; error: unknown }

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))

/**
 * Every repository the person can clone: the owners first (their account and organisations), then
 * each owner's list side by side. An owner that fails is reported and the others still show; an
 * older CLI without --orgs falls back to the person's own list.
 */
function useGithubListing(round: number): Listing {
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  useEffect(() => {
    let stopped = false
    setListing({ state: 'loading' })
    const load = async (): Promise<Listing> => {
      const owners = await api.githubOwners().catch(() => null)
      if (owners === null) return { state: 'done', owners: [], repositories: await api.githubRepositories(), errors: [] }
      const results = await Promise.allSettled(owners.map((owner) => api.githubRepositories(owner.login)))
      const repositories = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      const errors = results.flatMap((result, index) => (result.status === 'rejected' ? [`${owners[index]?.login ?? 'GitHub'}: ${message(result.reason)}`] : []))
      if (repositories.length === 0 && errors.length > 0) throw new Error(errors.join('\n'))
      return { state: 'done', owners, repositories, errors }
    }
    load().then(
      (value) => !stopped && setListing(value),
      (error: unknown) => !stopped && setListing({ state: 'error', error }),
    )
    return () => {
      stopped = true
    }
  }, [round])
  return listing
}

/** What the Clone button will clone: a listed repository, or a URL or owner/name typed in the search. */
type Source = { kind: 'listed'; repository: GithubRepository } | { kind: 'typed'; url: string; label: string }

export function GithubTab({ projects, home, onImported }: { projects: Project[]; home: string | null; onImported: () => void }) {
  const [round, setRound] = useState(0)
  const listing = useGithubListing(round)
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState(-1)
  const [destination, setDestination] = useState<string | null>(null)
  const [cloning, setCloning] = useState<{ url: string; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rows = useRef<(HTMLLIElement | null)[]>([])
  const search = useRef<HTMLInputElement>(null)
  const cloneButton = useRef<HTMLButtonElement>(null)

  const target = destination ?? (home === null ? null : defaultDestination(projects, home))
  const repositories = listing.state === 'done' ? listing.repositories : []
  const visible = visibleGithub(repositories, query, owner)
  const focused = moveFocus(focus, 0, visible.length)
  const typed = parseGithubSource(query)
  const typedUrl = typed.ok && !repositories.some((repository) => repository.url.toLowerCase() === typed.url.toLowerCase()) ? typed.url : null
  const chosen = repositories.find((repository) => repository.url === selected)
  const source: Source | null = chosen !== undefined ? { kind: 'listed', repository: chosen } : typedUrl !== null ? { kind: 'typed', url: typedUrl, label: typedUrl.replace('https://github.com/', '') } : null
  const sourceUrl = source === null ? null : source.kind === 'listed' ? source.repository.url : source.url
  const sourceLabel = source === null ? null : source.kind === 'listed' ? source.repository.nameWithOwner : source.label

  // Enter on a repository hands focus to Clone, which is enabled only once the selection renders.
  const [focusClone, setFocusClone] = useState(0)
  useEffect(() => {
    if (focusClone > 0) cloneButton.current?.focus()
  }, [focusClone])

  const select = (repository: GithubRepository, thenFocusClone = false) => {
    setSelected(repository.url)
    setError(null)
    if (thenFocusClone) setFocusClone((value) => value + 1)
  }

  const chooseDestination = () => {
    void api.pickFolder(target ?? undefined).then((picked) => {
      if (picked !== null) setDestination(picked)
    })
  }

  const cloneFrom = (url: string, label: string) => {
    if (cloning !== null) return
    if (target === null) {
      setError('Choose a destination folder.')
      return
    }
    setCloning({ url, label })
    setError(null)
    api.importClone(url, target).then(
      () => onImported(),
      (caught: unknown) => {
        setError(message(caught))
        setCloning(null)
      },
    )
  }

  const doClone = () => {
    if (sourceUrl !== null && sourceLabel !== null) cloneFrom(sourceUrl, sourceLabel)
  }

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && visible.length > 0) {
      event.preventDefault()
      setFocus(0)
      rows.current[0]?.focus()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey || (typedUrl !== null && visible.length === 0)) doClone()
      else if (visible[0] !== undefined && !isImportedGithub(visible[0], projects)) {
        select(visible[0], true)
      }
    }
  }

  const onListKey = (event: KeyboardEvent) => {
    const repository = visible[focused]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.key === 'ArrowUp' && focused === 0) {
        setFocus(-1)
        search.current?.focus()
        return
      }
      const next = moveFocus(focused, event.key === 'ArrowDown' ? 1 : -1, visible.length)
      setFocus(next)
      rows.current[next]?.focus()
    } else if ((event.key === 'Enter' || event.key === ' ') && repository !== undefined && !isImportedGithub(repository, projects)) {
      event.preventDefault()
      const now = event.key === 'Enter' && (event.metaKey || event.ctrlKey)
      select(repository, event.key === 'Enter' && !now)
      if (now) cloneFrom(repository.url, repository.nameWithOwner)
    }
  }

  const owners = listing.state === 'done' ? listing.owners : []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 px-7 pb-3">
        <SearchField inputRef={search} value={query} onChange={(value) => setQuery(value)} onKeyDown={onSearchKey} label="Search your GitHub repositories" placeholder="Search your repositories, or paste a URL or owner/name…" autoFocus />
        {owners.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Owner">
            {[null, ...owners.map((entry) => entry.login)].map((login) => {
              const on = owner === login
              const entry = owners.find((candidate) => candidate.login === login)
              const count = repositories.filter((repository) => login === null || repository.nameWithOwner.startsWith(`${login}/`)).length
              return (
                <button
                  key={login ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setOwner(login)}
                  className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${on ? 'border-white/[0.2] bg-white/[0.14] text-ink-100' : 'border-white/[0.08] text-ink-400 hover:text-ink-200'}`}
                >
                  {entry !== undefined && <OwnerAvatar owner={entry} />}
                  {login ?? 'All'}
                  {entry?.kind === 'user' && <span className="font-normal text-ink-500">you</span>}
                  <span className="font-normal text-ink-500">{count}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-4">
        {listing.state === 'loading' && <ListingSkeleton />}
        {listing.state === 'error' && (
          <div className="space-y-3">
            <ErrorNote error={listing.error} />
            <div className="flex items-center gap-3">
              <Button className="h-8 px-3.5 text-[12.5px]" onClick={() => setRound((value) => value + 1)}>
                Try again
              </Button>
              <span className="text-[12.5px] text-ink-500">You can still paste a URL or owner/name above.</span>
            </div>
          </div>
        )}
        {listing.state === 'done' && listing.errors.length > 0 && (
          <div className="mb-3">
            <ErrorNote error={`Some owners could not be listed:\n${listing.errors.join('\n')}`} />
          </div>
        )}
        {typedUrl !== null && (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className={`mb-2 flex w-full items-center gap-3 rounded-[16px] border px-3 py-2.5 text-left ${source?.kind === 'typed' ? 'border-accent/50 bg-accent/[0.12]' : 'border-white/[0.08] hover:bg-white/[0.05]'}`}
          >
            <RepoMark name={typedUrl.split('/').at(-1) ?? 'repo'} remote={typedUrl} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-ink-100">Clone {typedUrl.replace('https://github.com/', '')}</span>
              <span className="block truncate font-mono text-[11.5px] text-ink-500">{typedUrl}</span>
            </span>
          </button>
        )}
        {listing.state === 'done' && repositories.length === 0 && typedUrl === null && (
          <div className="rounded-[18px] bg-white/[0.03] px-4 py-8 text-center">
            <p className="text-[13.5px] text-ink-200">No repositories on this GitHub account</p>
            <p className="mt-1 text-[12.5px] text-ink-500">Paste a URL or owner/name above to clone someone else’s.</p>
          </div>
        )}
        {listing.state === 'done' && repositories.length > 0 && visible.length === 0 && typedUrl === null && <p className="px-1 py-4 text-[13px] text-ink-400">Nothing matches “{query.trim()}”. Paste a URL or owner/name to clone one that is not listed.</p>}
        {visible.length > 0 && (
          <ul role="listbox" aria-label="GitHub repositories" onKeyDown={onListKey} className="space-y-1">
            {visible.map((repository, index) => {
              const imported = isImportedGithub(repository, projects)
              const on = repository.url === selected
              return (
                <li
                  key={repository.url}
                  ref={(node) => {
                    rows.current[index] = node
                  }}
                  role="option"
                  aria-selected={on}
                  aria-disabled={imported}
                  tabIndex={index === focused ? 0 : -1}
                  onFocus={() => setFocus(index)}
                  onClick={() => !imported && select(repository)}
                  onDoubleClick={() => {
                    if (imported) return
                    select(repository, true)
                  }}
                  title={repository.description ?? repository.nameWithOwner}
                  className={`flex items-center gap-3 rounded-[16px] px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${imported ? 'cursor-default opacity-55' : 'cursor-pointer'} ${on ? 'bg-accent/[0.14]' : imported ? '' : 'hover:bg-white/[0.05]'}`}
                >
                  <RepoMark name={repository.nameWithOwner.split('/').at(-1) ?? repository.nameWithOwner} remote={repository.url} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-ink-100">
                        <span className="font-normal text-ink-400">{repository.nameWithOwner.split('/')[0]}/</span>
                        {repository.nameWithOwner.split('/')[1]}
                      </span>
                      <Chip>{repository.isPrivate ? 'Private' : 'Public'}</Chip>
                      {imported && <Chip tone="accent">Imported</Chip>}
                    </div>
                    <p className="truncate text-[12.5px] text-ink-400">{repository.description ?? <span className="text-ink-500">No description</span>}</p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-4 text-[12px] text-ink-400 md:flex">
                    {repository.primaryLanguage?.name !== undefined && (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-ink-400" />
                        {repository.primaryLanguage.name}
                      </span>
                    )}
                    {repository.stargazerCount !== undefined && (
                      <span className="inline-flex items-center gap-1" title={`${repository.stargazerCount} stars`}>
                        <StarIcon />
                        {repository.stargazerCount}
                      </span>
                    )}
                    <span className="w-[4.5rem] text-right text-ink-500" title={repository.updatedAt ?? undefined}>
                      {ago(repository.updatedAt)}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <footer className="space-y-3 border-t border-white/[0.08] px-7 py-4">
        {cloning !== null && (
          <div role="status" className="space-y-2">
            <p className="text-[13px] text-ink-200">
              Cloning <span className="font-semibold">{cloning.label}</span> into <span className="font-mono text-[12px]">{target === null ? '' : tildePath(cloneTarget(target, cloning.url), home)}</span>…
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full w-1/3 animate-[import-progress_1.2s_ease-in-out_infinite] rounded-full bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
            </div>
          </div>
        )}
        {error !== null && (
          <div role="alert">
            <ErrorNote error={error} />
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-ink-400">Into</span>
          <button
            type="button"
            onClick={chooseDestination}
            disabled={cloning !== null}
            title={target ?? 'Choose a destination folder'}
            className="inline-flex h-8 min-w-0 items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-3 font-mono text-[12px] text-ink-200 hover:bg-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
          >
            <span className="truncate">{target === null ? 'Choose folder…' : tildePath(sourceUrl === null ? target : cloneTarget(target, sourceUrl), home)}</span>
            <span className="shrink-0 font-sans text-ink-400">Change</span>
          </button>
          <span className="flex-1" />
          <span className="hidden lg:inline-flex">
            <KeyHint keys="⌘Enter">clone</KeyHint>
          </span>
          <Button ref={cloneButton} variant="primary" onClick={doClone} disabled={sourceUrl === null || cloning !== null}>
            {cloning !== null ? <Spinner /> : sourceLabel === null ? 'Clone' : `Clone ${sourceLabel.split('/').at(-1) ?? ''}`}
          </Button>
        </div>
      </footer>
    </div>
  )
}

function OwnerAvatar({ owner }: { owner: GithubOwner }) {
  const [failed, setFailed] = useState(false)
  const url = owner.avatarUrl ?? `https://github.com/${owner.login}.png?size=40`
  if (failed) return <span aria-hidden="true" className="size-4 rounded-full bg-white/[0.12]" />
  return <img src={url} alt="" onError={() => setFailed(true)} className={`size-4 bg-white/[0.06] ${owner.kind === 'organization' ? 'rounded-[4px]' : 'rounded-full'}`} />
}

function ListingSkeleton() {
  return (
    <div role="status" aria-label="Reading your GitHub repositories" className="space-y-1">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-3 rounded-[16px] px-3 py-2.5">
          <span className="size-8 shrink-0 animate-pulse rounded-[10px] bg-white/[0.06] motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <Bone width={`${30 + (row % 3) * 8}%`} />
            <Bone width={`${52 - (row % 2) * 12}%`} className="h-2.5" />
          </div>
        </div>
      ))}
    </div>
  )
}
