import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@/api/schema'
import { ErrorNote } from '@/components/ui'
import { emptyIssueFilters, filterIssues, issueFilterOptions, type IssueFilters, type IssueTab } from '@/github/github-model'
import { DetailPane, IssueRow, useListing } from '@/github/GithubPage'
import { Empty, FilterSelect, LoadMore, Tabs, anyValue, fromAny, people, pillButton } from '@/github/page-parts'
import { SkeletonRows, useNow } from '@/github/parts'
import { pageMx, pageX } from '@/lib/page'

// The Tasks page's list, the app's one list of a project's issues: the GitHub page's listing, rows,
// filters and detail pane, a page at a time, under the state tabs and the label and assignee filters;
// the bar's search narrows what is loaded. A row shows its issue beside the list, which maximises into
// the app's issue view.

export function TasksList({
  project,
  query,
  onClearQuery,
  selected,
  onSelect,
  onMaximise,
}: {
  project: Project
  query: string
  onClearQuery: () => void
  /** The issue shown beside the list. */
  selected: number | null
  onSelect: (number: number | null) => void
  onMaximise: (number: number) => void
}) {
  const now = useNow(30_000)
  const [tab, setTab] = useState<IssueTab>('open')
  const [picked, setPicked] = useState<Pick<IssueFilters, 'label' | 'assignee'>>({ label: null, assignee: null })
  const { listing, error, loading, loadingMore, reload, more } = useListing(project.path, { kind: 'issues', state: tab })
  const issues = useMemo(() => (listing?.kind === 'issues' ? listing.page.items : []), [listing])
  const shown = useMemo(() => filterIssues(issues, { ...emptyIssueFilters, ...picked, query }, tab), [issues, picked, query, tab])
  const options = useMemo(() => issueFilterOptions(issues), [issues])
  // Every state's total travels with each page, so the tabs keep their counts while another tab loads.
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    if (listing !== null) setCounts(listing.page.counts)
  }, [listing])
  useEffect(() => {
    setCounts(null)
    setPicked({ label: null, assignee: null })
  }, [project.path])
  const counted = (state: string) => counts?.[state] ?? null
  const filtered = query.trim() !== '' || picked.label !== null || picked.assignee !== null
  const clear = () => {
    setPicked({ label: null, assignee: null })
    onClearQuery()
  }
  const known = listing !== null
  const hasMore = (listing?.page.nextCursor ?? null) !== null
  const noun = `${tab === 'all' ? '' : `${tab} `}issues`
  const selectedIssue = issues.find((item) => item.number === selected) ?? null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selected !== null && !(event.target instanceof HTMLInputElement)) onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, onSelect])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex flex-wrap items-center gap-2 ${pageX} pt-4 pb-4`}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: 'Open', count: counted('open') },
            { value: 'closed', label: 'Closed', count: counted('closed') },
            { value: 'all', label: 'All', count: counted('all') },
          ]}
        />
        <FilterSelect label="Label" value={picked.label ?? anyValue} options={people('Any label', options.labels)} onChange={(value) => setPicked({ ...picked, label: fromAny(value) })} />
        <FilterSelect label="Assignee" value={picked.assignee ?? anyValue} options={people('Any assignee', options.assignees)} onChange={(value) => setPicked({ ...picked, assignee: fromAny(value) })} />
        {filtered && (
          <button type="button" onClick={clear} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
            Clear
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 border-t border-white/[0.06]">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-5">
          {!known && loading && <SkeletonRows />}
          {!known && !loading && error !== null && (
            <div className={`space-y-3 ${pageX} py-4`}>
              <ErrorNote error={error} />
              <button type="button" onClick={() => void reload()} className={pillButton}>
                Try again
              </button>
            </div>
          )}
          {known && error !== null && (
            <div className={`${pageX} pb-2`}>
              <ErrorNote error={error} />
            </div>
          )}
          {known && shown.length === 0 && !hasMore &&
            (filtered ? (
              <Empty title={`No ${noun} match`} detail="Try other words or clear the filters." action={<button type="button" onClick={clear} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title={`No ${noun}`} detail={`${project.name} has none right now.`} />
            ))}
          {known && shown.length > 0 && (
            <ul className={`${pageMx} divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60`}>
              {shown.map((item) => (
                <li key={item.number}>
                  <IssueRow item={item} selected={item.number === selected} now={now} onSelect={() => onSelect(item.number === selected ? null : item.number)} />
                </li>
              ))}
            </ul>
          )}
          {known && hasMore && <LoadMore onVisible={more} loading={loadingMore} loaded={issues.length} total={counted(tab)} />}
        </div>
        {selected !== null && <DetailPane key={selected} project={project} kind="issues" number={selected} pullRequest={null} issue={selectedIssue} onMaximise={() => onMaximise(selected)} onClose={() => onSelect(null)} />}
      </div>
    </div>
  )
}
