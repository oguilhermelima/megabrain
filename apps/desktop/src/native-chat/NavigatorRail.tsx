import type { Virtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { activeTurn, railLayout, stepTurn, tickHeight, type Turn } from '@/native-chat/navigator-rail'

/** The width the transcript leaves free on its right for the rail, as a margin class. */
export const railMargin = 'ml-6 mr-12'

// The rail keeps clear of the transcript's top and bottom edges by this much in all.
const railInset = 48

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const noMarks: ReadonlySet<number> = new Set()

/**
 * Ticks on the transcript's right edge, one per message of the person: hover previews it, a click scrolls to it.
 * While the chat is searched, the turns holding a match (`marked`, by turn index) show in the accent.
 */
export function NavigatorRail({ turns, virtualizer, scroller, marked = noMarks }: { turns: Turn[]; virtualizer: Virtualizer<HTMLDivElement, Element>; scroller: RefObject<HTMLDivElement | null>; marked?: ReadonlySet<number> }) {
  const [hovered, setHovered] = useState<number | null>(null)
  // The list re-renders on every scroll, so the turn in view is worked out here each time.
  const measurements = virtualizer.measurementsCache
  const height = virtualizer.scrollRect?.height ?? 0
  const active = activeTurn(
    turns.map((turn) => measurements[turn.row]?.start ?? 0),
    { offset: virtualizer.scrollOffset ?? 0, height, total: virtualizer.getTotalSize() },
  )
  const layout = railLayout(turns.length, active, Math.max(0, height - railInset))

  const go = (index: number) => {
    const turn = turns[index]
    if (turn !== undefined) virtualizer.scrollToIndex(turn.row, { align: 'start', behavior: 'smooth' })
  }

  // Alt+Up and Alt+Down while the transcript has focus; the listener reads the latest turn through a ref.
  const step = useRef((_delta: -1 | 1) => {})
  step.current = (delta) => go(stepTurn(active, delta, turns.length))
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      step.current(event.key === 'ArrowUp' ? -1 : 1)
    }
    element.addEventListener('keydown', onKey)
    return () => element.removeEventListener('keydown', onKey)
  }, [scroller])

  return (
    <nav aria-label="Messages" className="absolute top-1/2 right-2 flex w-8 -translate-y-1/2 flex-col items-end" onMouseLeave={() => setHovered(null)}>
      {layout.ticks.map((index) => {
        const turn = turns[index]
        if (turn === undefined) return null
        const current = index === active
        const hit = marked.has(index)
        return (
          // The button is as tall as the tick and its gap, so a 3 px tick is easy to hit.
          <button
            key={turn.key}
            type="button"
            aria-label={`${turn.preview === '' ? `Message ${index + 1}` : turn.preview}${hit ? ', has matches' : ''}`}
            aria-current={current ? 'location' : undefined}
            onClick={() => go(index)}
            onMouseEnter={() => setHovered(index)}
            onFocus={() => setHovered(index)}
            onBlur={() => setHovered(null)}
            className="group relative flex w-full items-center justify-end outline-none"
            style={{ height: tickHeight + layout.gap }}
          >
            <span
              className={`block rounded-full transition-[width,background-color] duration-150 ${current ? 'w-[30px]' : 'w-6'} ${hit ? 'bg-accent' : current ? 'bg-ink-300' : 'bg-ink-500 group-hover:bg-ink-400 group-focus-visible:bg-ink-400'}`}
              style={{ height: tickHeight }}
            />
            {hovered === index && (
              <span role="tooltip" className="pointer-events-none absolute right-full mr-3 flex max-w-[320px] items-baseline gap-2 rounded-lg border border-white/10 bg-ink-900/95 px-3 py-1.5 text-[12px] whitespace-nowrap shadow-lg">
                <span className="min-w-0 truncate text-ink-200">{turn.preview === '' ? `Message ${index + 1}` : turn.preview}</span>
                {turn.at !== null && <span className="shrink-0 text-ink-400">{clock(turn.at)}</span>}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
