import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubProject, GithubProjectItem } from '@/api/schema'
import { ContextMenu, openMenuFromKeyboard, useContextMenu, type MenuRow } from '@/components/ContextMenu'
import { FilterButton, FilterChips, FilterPanel } from '@/components/Filters'
import { useSheet } from '@/components/Sheet'
import { Toast, type ToastMessage } from '@/components/Toast'
import { ErrorNote } from '@/components/ui'
import { stateColors } from '@/github/github-model'
import { ChevronIcon, ClosedIssueIcon, ClosedPullRequestIcon, IssueIcon, MergedIcon, MoreIcon, PullRequestIcon, RefreshIcon } from '@/github/icons'
import { Empty, FilterSelect, IconButton, pillButton } from '@/github/page-parts'
import { OpenLink, SkeletonRows, openOnGithub } from '@/github/parts'
import { pageDivider, pageX } from '@/lib/page'
import { answeredItems, otherRepository } from '@/tasks/board-model'
import { boardKey, boardListReadDue, boardReadDue, createBoardMemory, mergedPages, readBoardPages, withItems, withProjects } from '@/tasks/board-cache'
import { boardSheetFields } from '@/tasks/BoardFilterBar'
import { Chips, ViewFilterBar, ViewTable, ViewTabs } from '@/tasks/BoardViews'
import { ItemPanel, type FieldWrite } from '@/tasks/ItemPanel'
import { ProjectActions } from '@/tasks/ProjectActions'
import { cardChips, editedItems, parseAddition, groupField, laneField, optionOf, projectViews, readViewPrefs, shownView, sortedItems, swimlanes, viewColumns, writeViewPrefs, type CardChip, type PendingEdit, type ViewColumn } from '@/tasks/board-view'
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
  const previousKey = useRef<string | null>(null)
  useEffect(() => setItems(boardCache().items[key]?.value ?? null), [key])
  // usePoll's `current` turns false once another board is shown, so an old board's pages never land.
  const poll = usePoll(
    boardItemsPolicy,
    async (current) => {
      const changedBoard = previousKey.current !== key
      previousKey.current = key
      const force = asked.current || changedBoard
      asked.current = false
      if (!boardReadDue(boardCache().items[key]?.at, Date.now(), force)) return
      setLoading(true)
      const before = shown.current ?? []
      let totalCount: number | undefined
      try {
        const cached = boardCache().items[key]
        const all = await readBoardPages({
          read: (after) => api.githubProject(root, board.number, board.owner, after),
          maxPages,
          current,
          show: (read, last) => setItems(last ? read : mergedPages(read, before)),
          ...(!force && cached?.totalCount !== undefined
            ? { unchanged: { items: cached.value, totalCount: cached.totalCount } }
            : {}),
          onTotalCount: (count) => {
            totalCount = count
          },
        })
        if (all === null) return
        remember(withItems(boardCache(), key, all, Date.now(), totalCount))
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
      if (entry !== undefined) remember(withItems(boardCache(), key, answeredItems(entry.value, item), entry.at, entry.totalCount))
    },
    [key],
  )
  /** An item added to the board: shown at once at the end, and kept, until the next read lists it. */
  const add = useCallback(
    (item: GithubProjectItem) => {
      setItems((current) => (current === null ? [item] : [...current.filter((entry) => entry.id !== item.id), item]))
      const entry = boardCache().items[key]
      if (entry !== undefined) {
        const isNew = !entry.value.some((value) => value.id === item.id)
        remember(
          withItems(
            boardCache(),
            key,
            [...entry.value.filter((value) => value.id !== item.id), item],
            entry.at,
            entry.totalCount === undefined ? undefined : entry.totalCount + Number(isNew),
          ),
        )
      }
    },
    [key],
  )
  return { items, answer, add, error, loading, reload: read }
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

function Card({ item, repo, chips, moving, onPointerDown, onOpen, onMenu }: { item: GithubProjectItem; repo: string; chips: readonly CardChip[]; moving: boolean; onPointerDown: (event: PointerEvent<HTMLElement>) => void; onOpen: () => void; onMenu: (event: MouseEvent<HTMLElement>) => void }) {
  const other = otherRepository(item, repo)
  return (
    <li onPointerDown={onPointerDown} onContextMenu={onMenu} className={`group relative cursor-grab space-y-2 rounded-[14px] border border-white/[0.07] bg-ink-850 px-3 py-2.5 transition-opacity select-none active:cursor-grabbing ${moving ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-1.5 pr-6 text-[11.5px] text-ink-400">
        <ItemIcon item={item} />
        {other !== null && <span className="min-w-0 truncate">{other}</span>}
        {item.number !== null && <span className="shrink-0 tabular-nums">#{item.number}</span>}
      </div>
      <button type="button" onClick={onOpen} className="block text-left text-[13px] leading-snug font-semibold text-ink-100 hover:underline focus-visible:outline-2 focus-visible:outline-accent">
        {item.title}
      </button>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Chips chips={chips} />
        </div>
      )}
      <button type="button" data-card-menu="" onClick={onMenu} aria-haspopup="menu" aria-label={`Move ${item.title}`} title="Move to" className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-ink-400 opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:opacity-100">
        <MoreIcon size={14} />
      </button>
    </li>
  )
}

/** A column: its option's colour, name, count and description, and a menu; collapsed, a narrow strip that still takes drops. */
function Column({ column, field, droppable, over, collapsed, onMenu, children }: { column: ViewColumn; field: string; droppable: boolean; over: boolean; collapsed: boolean; onMenu: (event: MouseEvent<HTMLElement>) => void; children: ReactNode }) {
  const dropTarget = droppable ? (column.id ?? '') : ''
  if (collapsed) {
    return (
      <section aria-label={column.name} data-board-column={dropTarget} onContextMenu={onMenu} className={`flex max-h-full w-11 shrink-0 flex-col items-center gap-2 rounded-[20px] border py-3 transition-colors ${over ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.07] bg-ink-900/60'}`}>
        <button type="button" onClick={onMenu} aria-haspopup="menu" aria-label={`${column.name} column menu`} className="grid size-6 place-items-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
          <MoreIcon size={14} />
        </button>
        <span aria-hidden="true" style={{ borderColor: column.color }} className="size-3 shrink-0 rounded-full border-2" />
        <span className="text-[12px] text-ink-500 tabular-nums">{column.items.length}</span>
        <h3 className="min-h-0 truncate text-[13px] font-semibold text-ink-100 [writing-mode:vertical-rl]">{column.name}</h3>
      </section>
    )
  }
  return (
    <section aria-label={column.name} data-board-column={dropTarget} className={`flex max-h-full w-[288px] shrink-0 flex-col rounded-[20px] border transition-colors ${over ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.07] bg-ink-900/60'}`}>
      <header onContextMenu={onMenu} className="shrink-0 px-4 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" style={{ borderColor: column.color }} className="size-3 shrink-0 rounded-full border-2" />
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-100">{column.name}</h3>
          <span className="shrink-0 text-[12px] text-ink-500 tabular-nums">{column.items.length}</span>
          <button type="button" onClick={onMenu} aria-haspopup="menu" aria-label={`${column.name} column menu`} className="-mr-1.5 grid size-6 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
            <MoreIcon size={14} />
          </button>
        </div>
        {column.description !== '' && <p className="mt-1 line-clamp-2 text-[12px] text-ink-500">{column.description}</p>}
      </header>
      {!droppable && <p className="-mt-1 shrink-0 px-4 pb-2.5 text-[12px] text-ink-500">Can’t drop here: a move sets {field}, it can’t clear it.</p>}
      {children}
    </section>
  )
}

/** The foot of a column: Add item opens a line that takes an issue or pull request URL, owner/repo#number, or a draft's title. */
function AddItem({ onAdd }: { onAdd: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mx-2.5 mb-2.5 shrink-0 rounded-[12px] px-2 py-1.5 text-left text-[12.5px] font-semibold text-ink-400 hover:bg-white/[0.05] hover:text-ink-100">
        + Add item
      </button>
    )
  }
  const submit = () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    onAdd(text).then(
      () => {
        setText('')
        setBusy(false)
      },
      () => setBusy(false),
    )
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="mx-2.5 mb-2.5 shrink-0">
      <input
        autoFocus
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        onBlur={() => text === '' && setOpen(false)}
        placeholder="Paste a URL, owner/repo#1, or type a draft title"
        aria-label="Add item"
        className="h-8 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.05] px-2.5 text-[12.5px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60 disabled:opacity-50"
      />
    </form>
  )
}

/** A swimlane: a collapsible band with its value, count and a menu, over the columns of its items. */
function Lane({ name, color, count, collapsed, onToggle, onMenu, children }: { name: string; color: string | null; count: number; collapsed: boolean; onToggle: () => void; onMenu: (event: MouseEvent<HTMLElement>) => void; children: ReactNode }) {
  return (
    <section aria-label={name} className="shrink-0">
      <header onContextMenu={onMenu} className={`sticky left-0 flex w-max items-center gap-2 ${pageX} py-2`}>
        <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex items-center gap-2 rounded-full pr-2 text-left hover:text-ink-100">
          <span className={`text-ink-400 transition-transform ${collapsed ? '-rotate-90' : ''}`}>
            <ChevronIcon size={12} />
          </span>
          {color !== null && <span aria-hidden="true" style={{ borderColor: color }} className="size-3 shrink-0 rounded-full border-2" />}
          <h3 className="text-[13px] font-semibold text-ink-100">{name}</h3>
          <span className="text-[12px] text-ink-500 tabular-nums">{count}</span>
        </button>
        <button type="button" onClick={onMenu} aria-haspopup="menu" aria-label={`${name} lane menu`} className="grid size-6 place-items-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
          <MoreIcon size={14} />
        </button>
      </header>
      {!collapsed && children}
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
  const { items, answer, add, error, loading, reload } = useBoardItems(root, board)
  const [viewerLogin, setViewerLogin] = useState<string | undefined>()
  useEffect(() => { let active = true; void api.githubViewerLogin().then((login) => { if (active) setViewerLogin(login) }, () => {}); return () => { active = false } }, [])
  const [pending, setPending] = useState<PendingEdit[]>([])
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const closeToast = useCallback(() => setToast(null), [])
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()
  const nextMove = useRef(0)
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
  const field = groupField(board, view)
  const lane = laneField(board, view)
  // Collapsed and hidden columns and collapsed lanes last for the session, as GitHub's own do.
  const [collapsedColumns, setCollapsedColumns] = useState<ReadonlySet<string>>(new Set())
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set())
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(new Set())
  const toggled = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set)
    if (!next.delete(id)) next.add(id)
    return next
  }
  const sheet = useSheet('tasks.board.filters')
  const options = useMemo(() => boardFilterOptions(items ?? [], filters), [items, filters])

  /** Sets the group field to `optionId`: Status through a move, any other single select as a field write. */
  const move = (item: GithubProjectItem, optionId: string) => {
    if (items === null || field === null) return
    const current = editedItems(items, pending).find((entry) => entry.id === item.id)
    if (current === undefined || optionOf(current, field) === optionId) return
    const id = ++nextMove.current
    setPending((list) => [...list, { id, itemId: item.id, field, optionId }])
    const write = field.id === board.statusField?.id ? api.githubProjectMove(root, board.number, item.id, optionId, board.owner) : api.githubProjectSetField(root, board.number, item.id, field.name, 'single-select', optionId, board.owner)
    // Applied to the newest state, so a refresh or another move meanwhile is kept.
    write.then(
      (answered) => {
        answer(answered)
        setPending((list) => list.filter((entry) => entry.id !== id))
      },
      (cause: unknown) => {
        setPending((list) => list.filter((entry) => entry.id !== id))
        const name = field.options.find((option) => option.id === optionId)?.name ?? 'that column'
        setToast({ id: `move-${id}`, text: `Couldn’t move “${item.title}” to ${name}: ${cause instanceof Error ? cause.message : String(cause)}` })
      },
    )
  }
  const { drag, start, swallowClick } = useCardDrag(move)

  /** The app's own detail for an issue or pull request of this repository; null for a draft or another repository's item. */
  const detailOf = (item: GithubProjectItem): (() => void) | null => {
    const number = item.number
    if (item.type === 'DRAFT_ISSUE' || number === null || otherRepository(item, repo) !== null) return null
    return () => onOpenGithub(item.type === 'PULL_REQUEST' ? 'pr' : 'issue', number)
  }
  // A card opens the side panel; the click a drag ends with does not.
  const [selected, setSelected] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const opener = (item: GithubProjectItem) => () => {
    if (!swallowClick()) setSelected(item.id)
  }
  /** One write from the side panel at a time: GitHub's answer replaces the item, a refusal leaves it and says why. */
  const write = (item: GithubProjectItem, what: string, run: () => Promise<GithubProjectItem | null>) => {
    setWriting(true)
    run().then(
      (answered) => {
        if (answered !== null) answer(answered)
        setWriting(false)
      },
      (cause: unknown) => {
        setWriting(false)
        setToast({ id: `write-${Date.now()}`, text: `Couldn’t ${what} “${item.title}”: ${cause instanceof Error ? cause.message : String(cause)}` })
      },
    )
  }
  const setField = (item: GithubProjectItem, { field, type, value }: FieldWrite) => write(item, `set ${field.name} on`, () => (field.id === board.statusField?.id ? api.githubProjectMove(root, board.number, item.id, value, board.owner) : api.githubProjectSetField(root, board.number, item.id, field.name, type, value, board.owner)))
  const editDraft = (item: GithubProjectItem, title: string, body: string) => {
    const optimistic = { ...item, title, body }
    answer(optimistic)
    setWriting(true)
    void api.githubProjectEditDraft(root, board.number, item.id, title, body, board.owner).then((updated) => { answer(updated); setWriting(false) }, (cause: unknown) => {
      answer(item)
      setWriting(false)
      setToast({ id: `draft-${Date.now()}`, text: `Couldn’t update “${item.title}”: ${cause instanceof Error ? cause.message : String(cause)}` })
    })
  }
  const clearField = (item: GithubProjectItem, name: string) => write(item, `clear ${name} on`, () => api.githubProjectClearField(root, board.number, item.id, name, board.owner))
  const archive = (item: GithubProjectItem) => {
    const archived = item.isArchived !== true
    write(item, archived ? 'archive' : 'restore', async () => {
      const result = await api.githubProjectSetArchived(root, board.number, item.id, archived, board.owner)
      if (result.isArchived) setSelected(null)
      return { ...item, isArchived: result.isArchived }
    })
  }
  const menuFor = (event: MouseEvent<HTMLElement>, item: GithubProjectItem, status: string | null) => {
    const moves: MenuRow[] = (field?.options ?? []).map((option) => ({ label: `Move to ${option.name}`, disabled: option.id === status, onSelect: () => move(item, option.id) }))
    const url = item.url
    const links: MenuRow[] = url === null ? [] : [{ label: 'Open on GitHub', icon: 'external', onSelect: () => void openOnGithub(url) }]
    openMenu(event, [moves, links].filter((section) => section.length > 0))
  }

  // The view's filter goes through the data layer's GitHub evaluator; the sheet's filters narrow what it matches.
  const matched = useMemo(() => (items === null ? null : query.trim() === '' ? { items, warnings: [] } : api.githubProjectFilter(board, items, query, { ...(viewerLogin === undefined ? {} : { me: viewerLogin }) })), [board, items, query, viewerLogin])
  // An archived item leaves the board, as on GitHub.
  const shown = matched === null ? null : sortedItems(filterBoardItems(editedItems(matched.items.filter((item) => item.isArchived !== true), pending), { ...filters, query: '' }), board, view)
  const columns = shown === null || field === null ? [] : viewColumns(field, shown)
  const noStatus = columns.find((column) => column.id === null)?.items.length ?? 0
  const sheetFields = boardSheetFields(filters, options, filter, field === null ? null : { on: showNoStatus, count: noStatus, onChange: setNoStatus })
  const moving = new Set(pending.map((entry) => entry.itemId))
  const card = (item: GithubProjectItem) => (
    <Card key={item.id} item={item} repo={repo} chips={cardChips(item, board, view, [field?.name ?? '', lane?.name ?? ''])} moving={moving.has(item.id) || drag?.item.id === item.id} onPointerDown={(event) => start(event, item)} onOpen={opener(item)} onMenu={(event) => menuFor(event, item, field === null ? null : optionOf(item, field))} />
  )

  /**
   * Adds an issue or pull request by reference, or a draft titled with the text, then sets the column's
   * option and the lane's when they are single selects, so it lands where it was typed.
   */
  const addTo = async (text: string, column: string | null, laneOption: string | null) => {
    const addition = parseAddition(text)
    if (addition === null || field === null) return
    try {
      let item = addition.kind === 'reference' ? await api.githubProjectAddItem(root, board.number, addition.reference, board.owner) : await api.githubProjectCreateDraft(root, board.number, addition.title, undefined, board.owner)
      add(item)
      if (column !== null) item = field.id === board.statusField?.id ? await api.githubProjectMove(root, board.number, item.id, column, board.owner) : await api.githubProjectSetField(root, board.number, item.id, field.name, 'single-select', column, board.owner)
      if (laneOption !== null && lane !== null && lane.dataType === 'SINGLE_SELECT') item = await api.githubProjectSetField(root, board.number, item.id, lane.name, 'single-select', laneOption, board.owner)
      add(item)
    } catch (cause: unknown) {
      setToast({ id: `add-${Date.now()}`, text: `Couldn’t add “${text.trim()}”: ${cause instanceof Error ? cause.message : String(cause)}` })
      throw cause
    }
  }
  const panelItem = selected === null || items === null ? undefined : editedItems(items, pending).find((item) => item.id === selected)
  const laneMenu = (event: MouseEvent<HTMLElement>) => {
    const ids = shown === null || lane === null ? [] : swimlanes(lane, shown).map((entry) => entry.id ?? '')
    openMenu(event, [[{ label: 'Collapse all', onSelect: () => setCollapsedLanes(new Set(ids)) }, { label: 'Expand all', onSelect: () => setCollapsedLanes(new Set()) }]])
  }
  const columnMenu = (event: MouseEvent<HTMLElement>, column: ViewColumn) => {
    const id = column.id ?? ''
    const collapsed = collapsedColumns.has(id)
    openMenu(event, [[
      { label: collapsed ? 'Expand column' : 'Collapse column', onSelect: () => setCollapsedColumns((set) => toggled(set, id)) },
      { label: 'Hide column', onSelect: () => setHiddenColumns((set) => new Set(set).add(id)) },
    ]])
  }
  const columnsFor = (list: ViewColumn[], laneOption: string | null = null) =>
    field !== null &&
    list
      .filter((column) => (showNoStatus || column.id !== null) && !hiddenColumns.has(column.id ?? ''))
      .map((column) => (
        <Column key={column.id ?? ''} column={column} field={field.name} droppable={column.id !== null} over={drag !== null && drag.over !== null && drag.over === column.id} collapsed={collapsedColumns.has(column.id ?? '')} onMenu={(event) => columnMenu(event, column)}>
          <ul onKeyDown={openMenuFromKeyboard} className="min-h-12 space-y-2 overflow-y-auto px-2.5 pb-2.5">
            {column.items.map(card)}
          </ul>
          <AddItem onAdd={(text) => addTo(text, column.id, laneOption)} />
        </Column>
      ))

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The project and its views; then the view's filter, with Refresh, Filter and Open on GitHub on the right. */}
        <div className={`flex items-center gap-2 ${pageX} pt-4`}>
          <FilterSelect label="Project" value={String(board.number)} options={boards.map((entry) => ({ value: String(entry.number), label: entry.closed ? `${entry.title} (closed)` : entry.title }))} onChange={(value) => onPick(Number(value))} />
          <ViewTabs views={views} shown={view?.id ?? null} onShow={showView} />
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <ProjectActions root={root} project={board} />
          </span>
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
            <ViewTable project={board} view={view} items={shown} onOpen={(item) => setSelected(item.id)} />
          </div>
        ) : field === null ? (
          <div className={`min-h-0 flex-1 overflow-y-auto border-t ${pageDivider} pt-3 pb-5`}>
            <p className={`${pageX} pb-3 text-[13px] text-ink-400`}>{board.title} has no Status or other single-select field to group by, so its items show as a list. Add one on GitHub to see them as a board.</p>
            <ul onKeyDown={openMenuFromKeyboard} className={`${pageX} grid max-w-[720px] gap-2`}>
              {shown.map(card)}
            </ul>
          </div>
        ) : (
          <div className={`flex min-h-0 flex-1 flex-col border-t ${pageDivider} pt-3`}>
            {hiddenColumns.size > 0 && (
              <p className={`${pageX} pb-2 text-[12px] text-ink-500`}>
                {hiddenColumns.size} hidden {hiddenColumns.size === 1 ? 'column' : 'columns'}{' '}
                <button type="button" onClick={() => setHiddenColumns(new Set())} className="font-semibold text-accent hover:underline">
                  Show all
                </button>
              </p>
            )}
            {lane === null ? (
              <div className={`flex min-h-0 flex-1 items-start gap-3 overflow-x-auto ${pageX} pb-5`}>{columnsFor(columns)}</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto pb-5">
                {swimlanes(lane, shown).map((entry) => {
                  const id = entry.id ?? ''
                  return (
                    <Lane key={id} name={entry.name} color={entry.color} count={entry.items.length} collapsed={collapsedLanes.has(id)} onToggle={() => setCollapsedLanes((set) => toggled(set, id))} onMenu={laneMenu}>
                      <div className={`flex items-start gap-3 ${pageX} pb-4`}>{columnsFor(viewColumns(field, entry.items), entry.id)}</div>
                    </Lane>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {drag !== null && (
          <div style={{ left: drag.x + 12, top: drag.y + 12 }} className="pointer-events-none fixed z-[70] max-w-64 rounded-[10px] border border-white/[0.12] bg-ink-850 px-2.5 py-1 text-[12.5px] text-ink-100 shadow-xl">
            <div className="text-[11px] font-medium text-accent">{drag.over === null ? `Drop on a ${field?.name ?? 'column'}` : `Move to ${field?.options.find((option) => option.id === drag.over)?.name ?? ''}`}</div>
            <div className="truncate">{drag.item.title}</div>
          </div>
        )}
        <ContextMenu menu={menu} onClose={closeMenu} />
      </div>
      {panelItem !== undefined && <ItemPanel key={panelItem.id} item={panelItem} project={board} busy={writing} onSet={(entry) => setField(panelItem, entry)} onClear={(entry) => clearField(panelItem, entry.name)} onEditDraft={(title, body) => editDraft(panelItem, title, body)} onArchive={() => archive(panelItem)} onOpenDetail={detailOf(panelItem)} onClose={() => setSelected(null)} />}
      <FilterPanel sheet={sheet} fields={sheetFields} />
      <Toast toast={toast} onClose={closeToast} />
    </div>
  )
}
