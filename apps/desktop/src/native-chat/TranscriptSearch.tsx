import type { Virtualizer } from '@tanstack/react-virtual'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { Tooltip } from '@/components/Tooltip'
import { findMatches, firstMatchFrom, matchLabel, occurrences, stepMatch, type SearchMatch } from '@/native-chat/transcript-search'

// The transcript is virtualised, so the matches are counted on the rows' text (transcript-search.ts) and
// marked in the rows that are on screen with the CSS Custom Highlight API: no markup of the messages
// changes, and a row scrolled into view is marked as it renders. Every open chat adds its ranges to the
// same two highlights, which styles.css paints.

const allRanges = new Map<string, Range[]>()
const currentRanges = new Map<string, Range[]>()
const supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

function paint() {
  if (!supported) return
  CSS.highlights.set('chat-search', new Highlight(...[...allRanges.values()].flat()))
  CSS.highlights.set('chat-search-current', new Highlight(...[...currentRanges.values()].flat()))
}

/** The ranges of the query in an element's text, in reading order. */
function rangesIn(element: Element, query: string): Range[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  const text = nodes.map((node) => node.data).join('')
  const length = query.trim().length
  const ranges: Range[] = []
  let node = 0
  let base = 0
  const locate = (offset: number): [Text, number] | null => {
    while (node < nodes.length && base + (nodes[node]?.data.length ?? 0) < offset) base += nodes[node++]?.data.length ?? 0
    const found = nodes[node]
    return found === undefined ? null : [found, offset - base]
  }
  for (const start of occurrences(text, query)) {
    const from = locate(start)
    const to = locate(start + length)
    if (from === null || to === null) continue
    const range = document.createRange()
    range.setStart(...from)
    range.setEnd(...to)
    ranges.push(range)
  }
  return ranges
}

export interface TranscriptSearch {
  open: boolean
  query: string
  matches: SearchMatch[]
  current: number
  show: () => void
  close: () => void
  setQuery: (query: string) => void
  step: (delta: 1 | -1) => void
  /** Bumped each time the bar is asked for, so a second Cmd+F selects the query again. */
  focusToken: number
}

/** The search's state for a transcript's rows; `rowInView` says where a new query starts. */
export function useTranscriptSearch(items: readonly NoticeDisplayItem[], rowInView: () => number): TranscriptSearch {
  const [open, setOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [current, setCurrent] = useState(-1)
  const [focusToken, setFocusToken] = useState(0)
  const matches = useMemo(() => (open ? findMatches(items, query) : []), [open, items, query])
  // New rows can arrive while searching; the current match stays in range.
  const shown = current >= matches.length ? matches.length - 1 : current
  return {
    open,
    query,
    matches,
    current: shown,
    show: () => {
      setOpen(true)
      setFocusToken((token) => token + 1)
    },
    close: () => {
      setOpen(false)
      setCurrent(-1)
    },
    setQuery: (next) => {
      setQueryState(next)
      setCurrent(firstMatchFrom(findMatches(items, next), rowInView()))
    },
    step: (delta) => setCurrent(stepMatch(shown, delta, matches.length)),
    focusToken,
  }
}

/**
 * Marks the matches in the rows on screen after every render of the list, and brings the current one
 * into view once each time it changes: the virtualiser scrolls its row in, then the match itself is
 * centred when the row is taller than the view.
 */
export function useSearchHighlights(search: TranscriptSearch, list: RefObject<HTMLDivElement | null>, virtualizer: Virtualizer<HTMLDivElement, Element>, onReveal: () => void) {
  const id = useId()
  const target = search.current === -1 ? null : (search.matches[search.current] ?? null)
  const reveal = useRef<SearchMatch | null>(null)

  useEffect(() => {
    if (target === null) return
    reveal.current = target
    onReveal()
    virtualizer.scrollToIndex(target.row, { align: 'center' })
    // Only a new current match scrolls; the list re-rendering does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.row, target?.index, search.query])

  useLayoutEffect(() => {
    const element = list.current
    if (!search.open || search.query.trim() === '' || element === null) {
      if (allRanges.delete(id) || currentRanges.delete(id)) paint()
      return
    }
    const rows = new Set(search.matches.map((match) => match.row))
    const all: Range[] = []
    let currentRange: Range | null = null
    for (const row of element.querySelectorAll<HTMLElement>('[data-index]')) {
      const index = Number(row.dataset.index)
      if (!rows.has(index)) continue
      const ranges = rangesIn(row, search.query)
      all.push(...ranges)
      // The rendered text can hold fewer matches than the row's text (markdown the search reads differently).
      if (target !== null && target.row === index) currentRange = ranges[Math.min(target.index, ranges.length - 1)] ?? null
    }
    allRanges.set(id, all)
    currentRanges.set(id, currentRange === null ? [] : [currentRange])
    paint()
    const wanted = reveal.current
    if (currentRange !== null && wanted !== null && wanted === target) {
      const box = currentRange.getBoundingClientRect()
      const view = element.getBoundingClientRect()
      if (box.top < view.top + 48 || box.bottom > view.bottom - 48) element.scrollTop += box.top - (view.top + view.height / 2)
      reveal.current = null
    }
  })

  useEffect(
    () => () => {
      allRanges.delete(id)
      currentRanges.delete(id)
      paint()
    },
    [id],
  )
}

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

const chevron = (up: boolean) => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
  </svg>
)

/** The bar at the top of the transcript: the query, where the current match is among all, the arrows and close. */
export function SearchBar({ search, onClose }: { search: TranscriptSearch; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [search.focusToken])
  const count = search.matches.length
  const empty = search.query.trim() === ''
  return (
    <div role="search" className="absolute top-2 right-14 z-20 flex w-[320px] max-w-[calc(100%-4.5rem)] items-center gap-1 rounded-full border border-white/[0.1] bg-ink-900/95 py-1 pr-1 pl-3 shadow-lg backdrop-blur">
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-400" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.25" />
        <path d="m10.25 10.25 3 3" />
      </svg>
      <input
        ref={input}
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            search.step(event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1)
          }
        }}
        placeholder="Search this chat"
        aria-label="Search this chat"
        spellCheck={false}
        className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-ink-100 outline-none placeholder:text-ink-500"
      />
      {!empty && (
        <span role="status" aria-live="polite" className={`shrink-0 px-1 text-[12px] tabular-nums ${count === 0 ? 'text-ink-500' : 'text-ink-400'}`}>
          {matchLabel(search.current, count)}
        </span>
      )}
      <Tooltip text="Previous match (Shift+Enter)">
        {(tip) => (
          <button type="button" {...tip} aria-label="Previous match" disabled={count === 0} onClick={() => search.step(-1)} className={iconButton}>
            {chevron(true)}
          </button>
        )}
      </Tooltip>
      <Tooltip text="Next match (Enter)">
        {(tip) => (
          <button type="button" {...tip} aria-label="Next match" disabled={count === 0} onClick={() => search.step(1)} className={iconButton}>
            {chevron(false)}
          </button>
        )}
      </Tooltip>
      <Tooltip text="Close (Esc)">
        {(tip) => (
          <button type="button" {...tip} aria-label="Close search" onClick={onClose} className={iconButton}>
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </Tooltip>
    </div>
  )
}
