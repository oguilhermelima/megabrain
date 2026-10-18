import { useCallback, useRef, useState } from 'react'
import { joinRuns, type RunsPage } from '@/github/actions-model'
import { anyLive, runsPage, type RunFilters } from '@/github/actions-requests'
import { actionsLivePolicy, actionsPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { usePoll } from '@/lib/usePoll'

/**
 * A repository's runs a page at a time: the first page read again every 10 s while a loaded run is
 * queued or running (once a minute otherwise, paused while the window is hidden), the next page on
 * asking. Changing the root, the filters or the page size starts over.
 */
export function useRuns(root: string | null, filters: RunFilters, limit: number) {
  const [page, setPage] = useState<RunsPage | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const key = JSON.stringify([root, filters.workflow, filters.branch, limit])
  const current = useRef(key)
  const loaded = useRef<RunsPage | null>(null)
  if (current.current !== key) {
    current.current = key
    loaded.current = null
  }
  const live = page !== null && anyLive(page.runs)
  const shown = loaded.current === null ? null : page

  const reload = usePoll(
    live ? actionsLivePolicy : actionsPolicy,
    async (stillCurrent) => {
      if (root === null) return
      setLoading(true)
      try {
        const first = await runsPage(root, filters, limit, null)
        if (!stillCurrent() || current.current !== key) return
        const joined = joinRuns(loaded.current, first, 'refresh')
        loaded.current = joined
        setPage((previous) => reuse(previous, joined))
        setError(null)
      } catch (cause: unknown) {
        if (stillCurrent()) setError(cause)
        throw cause
      } finally {
        if (stillCurrent()) setLoading(false)
      }
    },
    [key, live],
  )

  const more = useCallback(async () => {
    const base = loaded.current
    if (root === null || base === null || base.next === null || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await runsPage(root, filters, limit, base.next)
      if (current.current !== key) return
      const joined = joinRuns(loaded.current, next, 'more')
      loaded.current = joined
      setPage(joined)
    } catch (cause: unknown) {
      if (current.current === key) setError(cause)
    } finally {
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loadingMore])

  return { page: shown, error, loading, loadingMore, reload, more }
}
