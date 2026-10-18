import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@/api/schema'
import type { SheetField } from '@/components/filter-sheet-model'
import { FilterButton, FilterChips, FilterSheet } from '@/components/FilterSheet'
import { ErrorNote } from '@/components/ui'
import { emptyIssueFilters, noAssignee, type IssueFilters, type IssueTab } from '@/github/github-model'
import { DetailPane, IssueRow, searchSettleMs, useFilterOptions, usePagedListing } from '@/github/GithubPage'
import { Empty, Pager, Tabs, anyValue, fromAny, people, pillButton, splitList, useSettled } from '@/github/page-parts'
import { SkeletonRows, useNow } from '@/github/parts'
import { pageDivider, pageMx, pageX } from '@/lib/page'

// The Tasks page's list, the app's one list of a project's issues: the GitHub page's listing, rows,
// filters and detail pane, a page at a time under a pager, beneath one row of the state tabs and the
// Filter button, whose sheet holds the label and assignee filters; those and the bar's search are
// GitHub's, over every issue of the repository. A row shows its issue beside the list, which maximises into
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
  const search = useSettled(query, searchSettleMs)
  const { listing, error, loading, reload, index, cursors, go } = usePagedListing(project.path, { kind: 'issues', state: tab, filters: { ...emptyIssueFilters, ...picked, query: search } })
  const issues = useMemo(() => (listing?.kind === 'issues' ? listing.page.items : []), [listing])
  const options = useFilterOptions(project.path)
  const assignees = useMemo(() => [{ value: anyValue, label: 'Any assignee' }, { value: noAssignee, label: 'No assignee' }, ...options.people.map((login) => ({ value: login, label: login }))], [options.people])
  const [sheetOpen, setSheetOpen] = useState(false)
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const sheetFields: SheetField[] = [
    { kind: 'select', label: 'Label', value: picked.label ?? anyValue, options: people('Any label', options.labels), onChange: (value) => setPicked((current) => ({ ...current, label: fromAny(value) })) },
    { kind: 'select', label: 'Assignee', value: picked.assignee ?? anyValue, options: assignees, onChange: (value) => setPicked((current) => ({ ...current, assignee: fromAny(value) })) },
  ]
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => void listRef.current?.scrollTo({ top: 0 }), [index])
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
    <div className="relative flex h-full min-h-0 flex-col">
      <div className={`flex items-center gap-2 ${pageX} pt-4 pb-4`}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'open', label: 'Open', count: counted('open') },
            { value: 'closed', label: 'Closed', count: counted('closed') },
            { value: 'all', label: 'All', count: counted('all') },
          ]}
        />
        <span className="ml-auto" />
        <FilterButton fields={sheetFields} open={sheetOpen} onClick={() => setSheetOpen(!sheetOpen)} place="row" />
      </div>
      <FilterChips fields={sheetFields} className={`${pageX} -mt-1.5 pb-3`} />
      <div className={`flex min-h-0 flex-1 border-t ${pageDivider}`}>
        <div ref={listRef} className={splitList(selected !== null)}>
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
          {known && issues.length === 0 &&
            (filtered ? (
              <Empty title={`No ${noun} match`} detail="Try other words or clear the filters." action={<button type="button" onClick={clear} className={pillButton}>Clear filters</button>} />
            ) : (
              <Empty title={`No ${noun}`} detail={`${project.name} has none right now.`} />
            ))}
          {known && issues.length > 0 && (
            <ul className={`${pageMx} divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60`}>
              {issues.map((item) => (
                <li key={item.number}>
                  <IssueRow item={item} selected={item.number === selected} now={now} onSelect={() => onSelect(item.number === selected ? null : item.number)} />
                </li>
              ))}
            </ul>
          )}
          {listing !== null && issues.length > 0 && <Pager index={index} cursors={cursors} total={listing.page.totalCount} shown={issues.length} loading={loading} onPage={go} />}
        </div>
        {selected !== null && <DetailPane key={selected} project={project} kind="issues" number={selected} pullRequest={null} issue={selectedIssue} onMaximise={() => onMaximise(selected)} onClose={() => onSelect(null)} />}
      </div>
      <FilterSheet open={sheetOpen} fields={sheetFields} onClose={closeSheet} />
    </div>
  )
}
