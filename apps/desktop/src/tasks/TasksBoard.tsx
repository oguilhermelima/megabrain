import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubProject, GithubProjectItem } from '@/api/schema'
import { ContextMenu, openMenuFromKeyboard, useContextMenu, type MenuRow } from '@/components/ContextMenu'
import { FilterButton, FilterChips, FilterPanel } from '@/components/Filters'
import { useSheet } from '@/components/Sheet'
import { Toast, type ToastMessage } from '@/components/Toast'
import { ErrorNote } from '@/components/ui'
import { stateColors } from '@/github/github-model'
import { ClosedIssueIcon, ClosedPullRequestIcon, IssueIcon, MergedIcon, MoreIcon, PullRequestIcon, RefreshIcon } from '@/github/icons'
import { Empty, FilterSelect, IconButton, pillButton } from '@/github/page-parts'
import { Avatar, LabelChip, OpenLink, SkeletonRows, openOnGithub } from '@/github/parts'
import { pageDivider, pageX } from '@/lib/page'
import { answeredItems, boardColumns, movesItem, otherRepository, shownItems, withoutMove, type BoardColumn, type PendingMove } from '@/tasks/board-model'
import { boardKey, boardListReadDue, boardReadDue, createBoardMemory, mergedPages, readBoardPages, withItems, withProjects } from '@/tasks/board-cache'
import { boardSheetFields } from '@/tasks/BoardFilterBar'
import { ViewFilterBar, ViewTable, ViewTabs } from '@/tasks/BoardViews'
import { projectViews, readViewPrefs, shownView, sortedItems, writeViewPrefs } from '@/tasks/board-view'
import { boardFilterOptions, emptyBoardFilters, filterBoardItems, readBoardPrefs, writeBoardPrefs, type BoardFilters } from '@/tasks/board-filters'
import { shownBoard } from '@/tasks/tasks-model'
import { boardItemsPolicy, boardListPolicy } from '@/lib/poll-model'
import { usePoll } from '@/lib/usePoll'

// The Tasks page's board: one of the repository's GitHub Projects, picked under the bar, its items
// in a column per Status option (board-model.ts). A card moves by dragging it to another column, or
// from its menu (its … button, a right click or the menu key): the move shows at once and goes back,
// with a note, when GitHub refuses it. GitHub moves set a status, never clear one, so No status
// takes no drops and says so under its header; it shows only when asked for, remembered per viewer.
// A project without a Status field lists its items under a note.
// The board opens from its last read (board-cache.ts) and reads again behind it, a page at a time.
// Its filters (board-filters.ts) narrow every column, whose counts are of what they show.

/** A project's items come a page at a time; past this many pages the board shows what it has. */
const maxPages = 20
const dragThreshold = 4

const browserStorage = () => localStorage
// The board cache for the app's life (board-cache.ts), started from storage and trimmed like it.
const memory = createBoardMemory(browserStorage)
const boardCache = memory.get
const remember = memory.remember

/** The repository's projects: the last read at once, read again when five minutes old (usePoll), or on Refresh. */
function useBoards(root: string) {
  const [boards, setBoards] = useState<GithubProject[] | null>(() => boardCache().projects[root]?.value ?? null)
  const [error, setError] = useState<unknown>(null)
  const asked = useRef(false)
  useEffect(() => {
    setBoards(boardCache().projects[root]?.value ?? null)
    setError(null)
  }, [root])
  const poll = usePoll(
    boardListPolicy,
    async (current) => {
      const force = asked.current
      asked.current = false
      if (!boardListReadDue(boardCache().projects[root]?.at, Date.now(), force)) return
      try {
        const list = await api.githubProjects(root)
        remember(withProjects(boardCache(), root, list.projects, Date.now()))
        if (!current()) return
        setBoards(list.projects)
        setError(null)
      } catch (cause: unknown) {
        if (current()) setError(cause)
      }
    },
    [root],
  )
  const read = useCallback(() => {
    asked.current = true
    poll()
  }, [poll])
  return { boards, error, reload: read }
}

/**
 * Every item of the board: the last read at once, read again when older than a minute and every
 * minute after while the window shows (usePoll); each page shows as it arrives, over the items shown before it.
 */
function useBoardItems(root: string, board: GithubProject) {
  const key = boardKey(board)
  const [items, setItems] = useState<GithubProjectItem[] | null>(() => boardCache().items[key]?.value ?? null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const shown = useRef(items)
  shown.current = items
  // Refresh reads at once; a schedule or a reopened board reads only when the last read is a minute old.
  const asked = useRef(false)
  useEffect(() => setItems(boardCache().items[key]?.value ?? null), [key])
  // usePoll's `current` turns false once another board is shown, so an old board's pages never land.
  const poll = usePoll(
    boardItemsPolicy,
    async (current) => {
      const force = asked.current
      asked.current = false
      if (!boardReadDue(boardCache().items[key]?.at, Date.now(), force)) return
      setLoading(true)
      const before = shown.current ?? []
      try {
        const all = await readBoardPages({ read: (after) => api.githubProject(root, board.number, board.owner, after), maxPages, current, show: (read, last) => setItems(last ? read : mergedPages(read, before)) })
        if (all === null) return
        remember(withItems(boardCache(), key, all, Date.now()))
        setError(null)
      } catch (cause: unknown) {
        if (current()) setError(cause)
      } finally {
        if (current()) setLoading(false)
      }
    },
    [root, board.number, board.owner, key],
  )
  const read = useCallback(() => {
    asked.current = true
    poll()
  }, [poll])
  /** GitHub confirmed a move: the item it answers with replaces the one shown, and the one kept. */
  const answer = useCallback(
    (item: GithubProjectItem) => {
      setItems((current) => (current === null ? current : answeredItems(current, item)))
      const entry = boardCache().items[key]
      if (entry !== undefined) remember(withItems(boardCache(), key, answeredItems(entry.value, item), entry.at))
    },
    [key],
  )
  return { items, answer, error, loading, reload: read }
}

interface CardDrag {
  item: GithubProjectItem
  x: number
  y: number
  /** The Status option under the pointer; null over No status or outside the columns. */
  over: string | null
}

/** The Status option of the column under a point; a column that takes no drops carries an empty one. */
function columnAt(x: number, y: number): string | null {
  const status = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-column]')?.dataset.boardColumn ?? ''
  return status === '' ? null : status
}

/**
 * A card dragged with the pointer to a column; pointer events, not HTML5 drag and drop, which Tauri's
 * file drop handler takes (panes/usePaneDrag). Escape cancels; the click a drag ends with is swallowed.
 */
function useCardDrag(onDrop: (item: GithubProjectItem, status: string) => void) {
  const [drag, setDrag] = useState<CardDrag | null>(null)
  const dragged = useRef(false)
  const start = (event: PointerEvent<HTMLElement>, item: GithubProjectItem) => {
    if (event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest('[data-card-menu]') !== null)) return
    const from = { x: event.clientX, y: event.clientY }
    let active = false
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('keydown', key)
      setDrag(null)
    }
    const move = (next: globalThis.PointerEvent) => {
      if (!active && Math.hypot(next.clientX - from.x, next.clientY - from.y) < dragThreshold) return
      active = true
      setDrag({ item, x: next.clientX, y: next.clientY, over: columnAt(next.clientX, next.clientY) })
    }
    const up = (next: globalThis.PointerEvent) => {
      stop()
      if (!active) return
      // The click this release makes, if any, comes before the timer.
      dragged.current = true
      setTimeout(() => (dragged.current = false), 0)
      const over = columnAt(next.clientX, next.clientY)
      if (over !== null) onDrop(item, over)
    }
    const key = (next: globalThis.KeyboardEvent) => {
      if (next.key === 'Escape') stop()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('keydown', key)
  }
  const swallowClick = () => {
    const was = dragged.current
    dragged.current = false
    return was
  }
  return { drag, start, swallowClick }
}

function DraftIssueIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.4 2" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
    </svg>
  )
}

/** The item's kind and state, in GitHub's colours: an issue, a pull request or a draft. */
function ItemIcon({ item }: { item: GithubProjectItem }) {
  const [Icon, color, label] =
    item.type === 'DRAFT_ISSUE'
      ? [DraftIssueIcon, stateColors.draft, 'Draft']
      : item.type === 'PULL_REQUEST'
        ? item.state === 'MERGED'
          ? [MergedIcon, stateColors.merged, 'Merged pull request']
          : item.state === 'CLOSED'
            ? [ClosedPullRequestIcon, stateColors.closed, 'Closed pull request']
            : [PullRequestIcon, stateColors.open, 'Open pull request']
        : item.state === 'CLOSED'
          ? [ClosedIssueIcon, stateColors.merged, 'Closed issue']
          : [IssueIcon, stateColors.open, 'Open issue']
  return (
    <span style={{ color }} className="shrink-0" role="img" aria-label={label}>
      <Icon size={14} />
    </span>
  )
}

function Card({ item, repo, moving, onPointerDown, onOpen, onMenu }: { item: GithubProjectItem; repo: string; moving: boolean; onPointerDown: (event: PointerEvent<HTMLElement>) => void; onOpen: (() => void) | null; onMenu: (event: MouseEvent<HTMLElement>) => void }) {
  const other = otherRepository(item, repo)
  return (
    <li onPointerDown={onPointerDown} onContextMenu={onMenu} className={`group relative cursor-grab space-y-2 rounded-[14px] border border-white/[0.07] bg-ink-850 px-3 py-2.5 transition-opacity select-none active:cursor-grabbing ${moving ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-1.5 pr-6 text-[11.5px] text-ink-400">
        <ItemIcon item={item} />
        {other !== null && <span className="min-w-0 truncate">{other}</span>}
        {item.number !== null && <span className="shrink-0 tabular-nums">#{item.number}</span>}
      </div>
      {onOpen === null ? (
        <p className="text-[13px] leading-snug font-semibold text-ink-100">{item.title}</p>
      ) : (
        <button type="button" onClick={onOpen} className="block text-left text-[13px] leading-snug font-semibold text-ink-100 hover:underline focus-visible:outline-2 focus-visible:outline-accent">
          {item.title}
        </button>
      )}
      {(item.labels.length > 0 || item.assignees.length > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {item.labels.map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
          {item.assignees.length > 0 && (
            <span className="ml-auto flex -space-x-1.5" title={`Assigned to ${item.assignees.map((assignee) => assignee.login).join(', ')}`}>
              {item.assignees.slice(0, 3).map((assignee) => (
                <span key={assignee.login} className="rounded-full ring-2 ring-ink-850">
                  <Avatar login={assignee.login} size={18} />
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <button type="button" data-card-menu="" onClick={onMenu} aria-haspopup="menu" aria-label={`Move ${item.title}`} title="Move to" className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-ink-400 opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:opacity-100">
        <MoreIcon size={14} />
      </button>
    </li>
  )
}

function Column({ column, droppable, over, count, children }: { column: BoardColumn; droppable: boolean; over: boolean; count: number; children: ReactNode }) {
  return (
    <section aria-label={column.name} data-board-column={droppable ? (column.id ?? '') : ''} className={`flex max-h-full w-[288px] shrink-0 flex-col rounded-[20px] border transition-colors ${over ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.07] bg-ink-900/60'}`}>
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2.5">
        <span aria-hidden="true" style={{ borderColor: column.color }} className="size-3 shrink-0 rounded-full border-2" />
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100">{column.name}</h3>
        <span className="shrink-0 text-[12px] text-ink-500 tabular-nums">{count}</span>
      </header>
      {!droppable && <p className="-mt-1 shrink-0 px-4 pb-2.5 text-[12px] text-ink-500">Can’t drop here: a move sets a status, it can’t clear one.</p>}
      {children}
    </section>
  )
}

export function TasksBoard({ root, repo, remembered, onPick, onOpenGithub }: { root: string; repo: string; remembered: number | undefined; onPick: (number: number) => void; onOpenGithub: (kind: 'pr' | 'issue', number: number) => void }) {
  const { boards, error, reload: reloadBoards } = useBoards(root)
  const number = boards === null ? null : shownBoard(boards, remembered)
  const board = boards?.find((entry) => entry.number === number) ?? null
  if (boards === null) {
    return error === null ? (
      <div className="py-5">
        <SkeletonRows count={4} />
      </div>
    ) : (
      <div className={`space-y-3 ${pageX} py-6`}>
        <ErrorNote error={error} />
        <button type="button" onClick={reloadBoards} className={pillButton}>
          Try again
        </button>
      </div>
    )
  }
  if (board === null) return <Empty title="No GitHub Projects" detail={`${repo} is in no project yet. Link one to the repository on GitHub to see its board here.`} />
  return <Board key={`${board.owner}/${board.number}`} root={root} repo={repo} board={board} boards={boards} onReloadBoards={reloadBoards} onPick={onPick} onOpenGithub={onOpenGithub} />
}

function Board({ root, repo, board, boards, onReloadBoards, onPick, onOpenGithub }: { root: string; repo: string; board: GithubProject; boards: GithubProject[]; onReloadBoards: () => void; onPick: (number: number) => void; onOpenGithub: (kind: 'pr' | 'issue', number: number) => void }) {
  const { items, answer, error, loading, reload } = useBoardItems(root, board)
  const [pending, setPending] = useState<PendingMove[]>([])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const closeToast = useCallback(() => setToast(null), [])
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()
  const nextMove = useRef(0)
  const field = board.statusField
  const key = boardKey(board)
  const [filters, setFilters] = useState<BoardFilters>(() => readBoardPrefs(browserStorage).filters[key] ?? emptyBoardFilters)
  // Applied to the latest filters, so the sheet's Clear can reset several in a row.
  const filter = (patch: Partial<BoardFilters>) =>
    setFilters((current) => {
      const next = { ...current, ...patch }
      const prefs = readBoardPrefs(browserStorage)
      writeBoardPrefs(browserStorage, { ...prefs, filters: { ...prefs.filters, [key]: next } })
      return next
    })
  const [showNoStatus, setShowNoStatus] = useState(() => readBoardPrefs(browserStorage).showNoStatus)
  const setNoStatus = (on: boolean) => {
    setShowNoStatus(on)
    writeBoardPrefs(browserStorage, { ...readBoardPrefs(browserStorage), showNoStatus: on })
  }
  const views = useMemo(() => projectViews(board), [board])
  const [viewId, setViewId] = useState(() => shownView(views, readViewPrefs(browserStorage)[key])?.id ?? null)
  const view = views.find((entry) => entry.id === viewId) ?? views[0] ?? null
  const [query, setQuery] = useState(view?.filter ?? '')
  const showView = (id: string) => {
    setViewId(id)
    setQuery(views.find((entry) => entry.id === id)?.filter ?? '')
    writeViewPrefs(browserStorage, { ...readViewPrefs(browserStorage), [key]: id })
  }
  const sheet = useSheet('tasks.board.filters')
  const options = useMemo(() => boardFilterOptions(items ?? [], filters), [items, filters])

  const move = (item: GithubProjectItem, status: string) => {
    if (items === null || !movesItem(items, pending, item.id, status)) return
    const id = ++nextMove.current
    setPending((current) => [...current, { id, itemId: item.id, status }])
    // Applied to the newest state, so a refresh or another move meanwhile is kept.
    api.githubProjectMove(root, board.number, item.id, status, board.owner).then(
      (answered) => {
        answer(answered)
        setPending((current) => withoutMove(current, id))
      },
      (cause: unknown) => {
        setPending((current) => withoutMove(current, id))
        const name = field?.options.find((option) => option.id === status)?.name ?? 'that column'
        setToast({ id: `move-${id}`, text: `Couldn’t move “${item.title}” to ${name}: ${cause instanceof Error ? cause.message : String(cause)}` })
      },
    )
  }
  const { drag, start, swallowClick } = useCardDrag(move)

  const opener = (item: GithubProjectItem): (() => void) | null => {
    const inApp = item.type !== 'DRAFT_ISSUE' && item.number !== null && otherRepository(item, repo) === null
    const url = item.url
    if (!inApp && url === null) return null
    return () => {
      if (swallowClick()) return
      if (inApp && item.number !== null) onOpenGithub(item.type === 'PULL_REQUEST' ? 'pr' : 'issue', item.number)
      else if (url !== null) void openOnGithub(url)
    }
  }
  const menuFor = (event: MouseEvent<HTMLElement>, item: GithubProjectItem, status: string | null) => {
    const moves: MenuRow[] = (field?.options ?? []).map((option) => ({ label: `Move to ${option.name}`, disabled: option.id === status, onSelect: () => move(item, option.id) }))
    const url = item.url
    const links: MenuRow[] = url === null ? [] : [{ label: 'Open on GitHub', icon: 'external', onSelect: () => void openOnGithub(url) }]
    openMenu(event, [moves, links].filter((section) => section.length > 0))
  }

  // The view's filter goes through the data layer's GitHub evaluator; the sheet's filters narrow what it matches.
  const matched = useMemo(() => (items === null ? null : query.trim() === '' ? { items, warnings: [] } : api.githubProjectFilter(board, items, query)), [board, items, query])
  const shown = matched === null ? null : sortedItems(filterBoardItems(shownItems(matched.items, pending), { ...filters, query: '' }), board, view)
  const columns = shown === null || field === null ? [] : boardColumns(field, shown)
  const noStatus = columns.find((column) => column.id === null)?.items.length ?? 0
  const sheetFields = boardSheetFields(filters, options, filter, field === null ? null : { on: showNoStatus, count: noStatus, onChange: setNoStatus })
  const moving = new Set(pending.map((entry) => entry.itemId))
  const card = (item: GithubProjectItem) => (
    <Card key={item.id} item={item} repo={repo} moving={moving.has(item.id) || drag?.item.id === item.id} onPointerDown={(event) => start(event, item)} onOpen={opener(item)} onMenu={(event) => menuFor(event, item, item.status)} />
  )

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The project and its views; then the view's filter, with Refresh, Filter and Open on GitHub on the right. */}
        <div className={`flex items-center gap-2 ${pageX} pt-4`}>
          <FilterSelect label="Project" value={String(board.number)} options={boards.map((entry) => ({ value: String(entry.number), label: entry.closed ? `${entry.title} (closed)` : entry.title }))} onChange={(value) => onPick(Number(value))} />
          <ViewTabs views={views} shown={view?.id ?? null} onShow={showView} />
        </div>
        <div className={`flex items-center gap-2 ${pageX} pt-3 pb-4`}>
          <ViewFilterBar value={query} saved={view?.filter ?? ''} count={shown?.length ?? null} warnings={matched?.warnings ?? []} onChange={setQuery} />
          <span className="ml-auto" />
          <IconButton
            label="Refresh"
            onClick={() => {
              onReloadBoards()
              void reload()
            }}
            spinning={loading && items !== null}>
            <RefreshIcon size={15} />
          </IconButton>
          <FilterButton fields={sheetFields} sheet={sheet} place="row" />
          <OpenLink url={board.url} />
        </div>
        <FilterChips fields={sheetFields} className={`${pageX} -mt-1.5 pb-3`} />
        {error !== null && (
          <div className={`${pageX} pb-3`}>
            <ErrorNote error={error} />
          </div>
        )}
        {shown === null ? (
          error === null && <SkeletonRows count={4} />
        ) : view?.layout === 'TABLE_LAYOUT' ? (
          <div className={`min-h-0 flex-1 overflow-auto border-t ${pageDivider} ${pageX} pb-5`}>
            <ViewTable project={board} view={view} items={shown} onOpen={(item) => opener(item)?.()} />
          </div>
        ) : field === null ? (
          <div className={`min-h-0 flex-1 overflow-y-auto border-t ${pageDivider} pt-3 pb-5`}>
            <p className={`${pageX} pb-3 text-[13px] text-ink-400`}>{board.title} has no Status field, so its items show as a list. Add a Status field on GitHub to see them as a board.</p>
            <ul onKeyDown={openMenuFromKeyboard} className={`${pageX} grid max-w-[720px] gap-2`}>
              {shown.map(card)}
            </ul>
          </div>
        ) : (
          <div className={`flex min-h-0 flex-1 items-start gap-3 overflow-x-auto border-t ${pageDivider} ${pageX} pt-3 pb-5`}>
            {columns.filter((column) => showNoStatus || column.id !== null).map((column) => (
              <Column key={column.id ?? ''} column={column} droppable={column.id !== null} over={drag !== null && drag.over !== null && drag.over === column.id} count={column.items.length}>
                <ul onKeyDown={openMenuFromKeyboard} className="min-h-12 space-y-2 overflow-y-auto px-2.5 pb-2.5">
                  {column.items.map(card)}
                </ul>
              </Column>
            ))}
          </div>
        )}
        {drag !== null && (
          <div style={{ left: drag.x + 12, top: drag.y + 12 }} className="pointer-events-none fixed z-[70] max-w-64 rounded-[10px] border border-white/[0.12] bg-ink-850 px-2.5 py-1 text-[12.5px] text-ink-100 shadow-xl">
            <div className="text-[11px] font-medium text-accent">{drag.over === null ? 'Drop on a status' : `Move to ${field?.options.find((option) => option.id === drag.over)?.name ?? ''}`}</div>
            <div className="truncate">{drag.item.title}</div>
          </div>
        )}
        <ContextMenu menu={menu} onClose={closeMenu} />
      </div>
      <FilterPanel sheet={sheet} fields={sheetFields} />
      <Toast toast={toast} onClose={closeToast} />
    </div>
  )
}
