import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { GithubPullRequestFile } from '@/api/schema'
import { emptyPages, filesPerPage, nextPage, pageArrived, patchCacheSize, touchLru, type FilePages } from '@/github/pr-files-model'

// A pull request's changed files as the Files tab reads them: the list a page at a time, without
// patches, and each file's patch on its own when it nears the viewport. Patches are kept for the
// most recently seen files only; one released is fetched again when it comes back into view.

/** Patches fetched at once; the rest wait their turn. */
const parallelFetches = 4

export interface PullRequestFiles {
  pages: FilePages
  pagesError: unknown
  /** The file with its patch, once fetched and while it stays in the cache. */
  patchOf: (path: string) => GithubPullRequestFile | undefined
  /** Paths fetched or being fetched. */
  known: ReadonlySet<string>
  diffError: (path: string) => unknown
  /** Asks the next page when the list nears its end (every page while a filter is on). */
  needPage: (lastShown: number, filtering: boolean) => void
  /** Fetches the given diffs and keeps the files on screen from being released. */
  showDiffs: (fetch: string[], onScreen: string[]) => void
  retryDiff: (path: string) => void
  /** The person's viewed marks this session, over what GitHub reported. */
  marks: Readonly<Record<string, boolean>>
  /** Marks a file viewed or not at once; a refusal drops the mark (back to GitHub's) and keeps gh's message. */
  setViewed: (path: string, viewed: boolean) => void
  viewedError: unknown
  reload: () => void
}

export function usePullRequestFiles(root: string, number: number, wanted: boolean): PullRequestFiles {
  const [pages, setPages] = useState<FilePages>(emptyPages)
  const [pagesError, setPagesError] = useState<unknown>(null)
  const [marks, setMarks] = useState<Record<string, boolean>>({})
  const [viewedError, setViewedError] = useState<unknown>(null)
  const [, setVersion] = useState(0)
  const generation = useRef(0)
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const patches = useRef(new Map<string, GithubPullRequestFile>())
  const errors = useRef(new Map<string, unknown>())
  const inFlight = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const order = useRef<string[]>([])
  const pinned = useRef<ReadonlySet<string>>(new Set())
  const known = useRef(new Set<string>())
  const bump = useCallback(() => setVersion((value) => value + 1), [])

  const needPage = useCallback(
    (lastShown: number, filtering: boolean) => {
      const state = pagesRef.current
      const page = nextPage(state, lastShown, filtering)
      if (page === null) return
      const asked = generation.current
      const loading = { ...state, loading: true }
      pagesRef.current = loading
      setPages(loading)
      setPagesError(null)
      api.prFilesPage(root, number, page, filesPerPage).then(
        (result) => {
          if (asked !== generation.current) return
          setPages((current) => {
            const next = pageArrived(current, result)
            pagesRef.current = next
            return next
          })
        },
        (caught: unknown) => {
          if (asked !== generation.current) return
          setPagesError(caught)
          setPages((current) => {
            const next = { ...current, loading: false }
            pagesRef.current = next
            return next
          })
        },
      )
    },
    [root, number],
  )

  const pump = useCallback(() => {
    const asked = generation.current
    while (inFlight.current.size < parallelFetches) {
      const path = queue.current.shift()
      if (path === undefined) return
      inFlight.current.add(path)
      api.prFile(root, number, path).then(
        (file) => {
          if (asked !== generation.current) return
          inFlight.current.delete(path)
          patches.current.set(path, file)
          const touched = touchLru(order.current, [path], patchCacheSize, pinned.current)
          order.current = touched.order
          for (const gone of touched.evicted) {
            patches.current.delete(gone)
            known.current.delete(gone)
          }
          bump()
          pump()
        },
        (caught: unknown) => {
          if (asked !== generation.current) return
          inFlight.current.delete(path)
          errors.current.set(path, caught)
          bump()
          pump()
        },
      )
    }
  }, [root, number, bump])

  const showDiffs = useCallback(
    (fetch: string[], onScreen: string[]) => {
      pinned.current = new Set(onScreen)
      order.current = touchLru(order.current, onScreen.filter((path) => patches.current.has(path)), Number.POSITIVE_INFINITY, pinned.current).order
      // Files that scrolled away before their turn are not fetched after all.
      for (const path of queue.current) if (!pinned.current.has(path)) known.current.delete(path)
      queue.current = queue.current.filter((path) => pinned.current.has(path))
      for (const path of fetch) {
        if (known.current.has(path) || errors.current.has(path)) continue
        known.current.add(path)
        queue.current.push(path)
      }
      pump()
    },
    [pump],
  )

  const retryDiff = useCallback(
    (path: string) => {
      errors.current.delete(path)
      known.current.delete(path)
      bump()
      showDiffs([path], [...pinned.current, path])
    },
    [bump, showDiffs],
  )

  const setViewed = useCallback(
    (path: string, viewed: boolean) => {
      const asked = generation.current
      setViewedError(null)
      setMarks((current) => ({ ...current, [path]: viewed }))
      api.setFileViewed(root, number, path, viewed).catch((caught: unknown) => {
        if (asked !== generation.current) return
        setViewedError(caught)
        setMarks((current) => {
          const { [path]: _dropped, ...rest } = current
          return rest
        })
      })
    },
    [root, number],
  )

  const reload = useCallback(() => {
    generation.current++
    setMarks({})
    setViewedError(null)
    patches.current.clear()
    errors.current.clear()
    inFlight.current.clear()
    known.current.clear()
    queue.current = []
    order.current = []
    pagesRef.current = emptyPages
    setPages(emptyPages)
    setPagesError(null)
    bump()
  }, [bump])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (wanted && pages.pages === 0 && !pages.loading && pagesError === null) needPage(-1, false)
  }, [wanted, pages, pagesError, needPage])

  return {
    pages,
    pagesError,
    patchOf: (path) => patches.current.get(path),
    known: known.current,
    diffError: (path) => errors.current.get(path) ?? null,
    needPage,
    showDiffs,
    retryDiff,
    marks,
    setViewed,
    viewedError,
    reload,
  }
}
