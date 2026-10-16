import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { equaliseSplit, resizeSplit, zonePreview, type Divider, type Edge, type Panes, type Rect } from '@/panes/pane-model'
import { sideBand, type PaneDrag } from '@/panes/usePaneDrag'
import { columnAt, minPaneHeight, minPaneWidth, resetColumn, resizeColumn, reveal, stripEdges, type Strip, type StripColumn, type StripLayout } from '@/panes/strip'
import { useStripScroll } from '@/panes/useStripScroll'
import { WindowRowContext, type WindowRowJoin } from '@/panes/window-row'
import { PaneChromeContext, type PaneChrome } from '@/panes/pane-chrome'

/** What a pane shows for its item: the title on its header, and the view. */
export interface PaneContent {
  title: string
  node: ReactNode
}

const percent = (rect: Rect): CSSProperties => ({ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` })

const pixels = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

/**
 * The main area as panes, laid out as a strip of columns (panes/strip) that scrolls sideways when
 * they do not fit, each column scrolling its own stack. Every view is placed absolutely and keyed by
 * its item, all of them siblings, so splitting, moving, resizing or scrolling never remounts it: a
 * draft, a scroll position and a terminal's screen survive. Items in `background` stay mounted but
 * hidden (terminals keep running and report their exit while no pane shows them).
 */
export function PaneArea({
  panes,
  onPanes,
  background,
  render,
  drag,
  onClose,
  overlay,
  windowRow = null,
  strip,
  stripKey,
  onStrip,
  onOverflow,
}: {
  panes: Panes
  onPanes: (change: (current: Panes) => Panes) => void
  background: readonly string[]
  render: (item: string) => PaneContent
  drag: PaneDrag
  onClose: (paneId: string) => void
  /** Laid over the panes, under their focus ring, drop previews and dividers (the code layer). */
  overlay?: ReactNode
  /** The pane header that shares the window's top row, and the room it leaves at its left (panes/window-row). */
  windowRow?: { join: WindowRowJoin; inset: number } | null
  /** The shown group's column widths and scroll; `stripKey` names the group, null for one pane alone. */
  strip: Strip
  stripKey: string | null
  onStrip: ((change: (strip: Strip) => Strip) => void) | null
  /** Told whether the strip scrolls, so the window row knows the top-left pane can move away. */
  onOverflow?: (scrolls: boolean) => void
}) {
  const scroll = useStripScroll({ root: panes.root, focused: panes.focused, strip, stripKey, onStrip, onOverflow })
  const { layout, size } = scroll
  const rects = layout.columns.flatMap((column) => {
    const offset = scroll.offsetOf(column)
    return column.panes.map((pane) => ({ ...pane, rect: { ...pane.rect, x: column.x + pane.rect.x, y: pane.rect.y - offset }, top: pane.rect.y }))
  })
  const split = rects.length > 1
  const dragging = drag.state
  const target = dragging?.target ?? null
  // Dropping a pane on itself, or an item on the pane that shows it, does nothing, so it shows no preview.
  const source = dragging?.source ?? null
  const paneTarget = target?.kind === 'pane' ? target : null
  const targetItem = paneTarget === null ? null : (rects.find((pane) => pane.id === paneTarget.paneId)?.item ?? null)
  const preview = paneTarget !== null && source !== null && !(source.kind === 'pane' ? source.paneId === paneTarget.paneId : source.item === targetItem) ? paneTarget : null
  // While something is dragged over a split, a band along each of its edges takes a drop that spans that whole side.
  const sides = dragging !== null && split
  const side = sides && target?.kind === 'side' ? target.side : null

  // The panes whose item's own top bar is their header (panes/pane-chrome); the rest keep a strip.
  const [headed, setHeaded] = useState<ReadonlySet<string>>(new Set())
  const chromes = useRef(new Map<string, PaneChrome>())
  const latest = useRef({ drag, onClose })
  latest.current = { drag, onClose }
  const chromeOf = (paneId: string, title: string): PaneChrome => {
    const known = chromes.current.get(paneId)
    // One object per pane and title, so a top bar's claim effect does not run again every render.
    if (known !== undefined && known.title === title) return known
    const made: PaneChrome = {
      title,
      onDrag: (event) => latest.current.drag.start(event, { kind: 'pane', paneId, label: title }),
      onClose: () => latest.current.onClose(paneId),
      claim: () => {
        setHeaded((current) => new Set([...current, paneId]))
        return () =>
          setHeaded((current) => {
            const next = new Set(current)
            next.delete(paneId)
            return next
          })
      },
    }
    chromes.current.set(paneId, made)
    return made
  }

  const focus = (paneId: string) => {
    if (paneId !== panes.focused) onPanes((current) => ({ ...current, focused: paneId }))
  }

  // Items opened into a pane rise into view. The ones already there when the area first renders do
  // not; one of them that goes to the background loses that, so it rises when it comes back. The
  // class stays on, so the animation plays once when the view mounts or stops being hidden, never
  // when a pane is moved or resized.
  const initial = useRef<Set<string> | null>(null)
  if (initial.current === null) initial.current = new Set(rects.map((pane) => pane.item))
  const quiet = initial.current

  const slots: { item: string; pane: (typeof rects)[number] | null }[] = [...rects.map((pane) => ({ item: pane.item, pane })), ...background.map((item) => ({ item, pane: null }))]
  // React keeps a keyed child only among the same siblings, so every slot renders here in one stable order.
  slots.sort((left, right) => (left.item < right.item ? -1 : left.item > right.item ? 1 : 0))
  const contents = new Map(slots.map(({ item }) => [item, render(item)]))
  // A column goes by its focused pane's title, else its first pane's.
  const titles = Object.fromEntries(
    layout.columns.map((column) => {
      const named = column.panes.find((pane) => pane.id === panes.focused) ?? column.panes[0]
      return [column.id, named === undefined ? '' : (contents.get(named.item)?.title ?? '')]
    }),
  )

  return (
    <div ref={scroll.area} data-pane-area={split ? '' : undefined} className="relative min-h-0 flex-1">
      {/* Sideways scrolling is native, so a two-finger swipe moves the strip; its bar is the minimap. */}
      <div ref={scroll.scroller} className="absolute inset-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="relative h-full" style={{ width: Math.max(layout.width, size.width) }}>
          {slots.map(({ item, pane }) => {
            const content = contents.get(item) ?? render(item)
            const focused = pane !== null && split && pane.id === panes.focused
            if (pane === null) quiet.delete(item)
            const joined = pane !== null && windowRow?.join.paneId === pane.id ? windowRow : null
            const chrome = split && pane !== null ? chromeOf(pane.id, content.title) : null
            return (
              <section
                key={item}
                data-pane-id={pane?.id}
                aria-label={pane === null ? undefined : content.title}
                onPointerDownCapture={pane === null ? undefined : () => focus(pane.id)}
                style={pane === null ? undefined : pixels(pane.rect)}
                className={pane === null ? 'hidden' : `absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${pane.rect.x > 0 ? 'border-l border-white/[0.07]' : ''} ${pane.top > 0 ? 'border-t border-white/[0.07]' : ''}`}
              >
                {split && pane !== null && !headed.has(pane.id) && (
                  <PaneHeader
                    title={content.title}
                    focused={pane.id === panes.focused}
                    inset={joined?.join.header === 'strip' ? joined.inset : null}
                    onDrag={(event) => drag.start(event, { kind: 'pane', paneId: pane.id, label: content.title })}
                    onClose={() => onClose(pane.id)}
                  />
                )}
                {/* Positioned, so a PR or Diff view can lie over the item's own content below its top bar. */}
                <div className={`relative flex min-h-0 flex-1 flex-col ${quiet.has(item) ? '' : 'motion-rise'}`}>
                  <WindowRowContext.Provider value={joined?.join.header === 'top-bar' ? joined.inset : null}>
                    <PaneChromeContext.Provider value={chrome}>{content.node}</PaneChromeContext.Provider>
                  </WindowRowContext.Provider>
                </div>
                {focused && <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-40 ring-1 ring-accent/50 ring-inset" />}
                {pane !== null && preview?.paneId === pane.id && <DropPreview rect={zonePreview(preview.zone)} label={preview.zone === 'center' ? (source?.kind === 'pane' ? 'Swap' : 'Replace') : 'Split here'} />}
              </section>
            )
          })}
          {overlay}
          {layout.columns.map((column) => {
            const offset = scroll.offsetOf(column)
            return column.dividers.map((divider) => <DividerHandle key={`${divider.splitId}:${divider.index}`} divider={divider} column={column} offset={offset} panes={panes} onPanes={onPanes} />)
          })}
          {layout.columns.length > 1 && onStrip !== null && layout.columns.map((column) => <ColumnEdge key={`edge:${column.id}`} column={column} layout={layout} root={panes.root} strip={strip} area={size} onStrip={onStrip} />)}
          {layout.columns.map((column) => column.height > size.height + 1 && <ColumnScrollbar key={`bar:${column.id}`} column={column} offset={scroll.offsetOf(column)} view={size.height} />)}
        </div>
      </div>
      {sides && (['top', 'bottom', 'left', 'right'] as const).map((edge) => <SideBand key={edge} edge={edge} lit={side === edge} />)}
      {side !== null && <DropPreview rect={zonePreview(side)} label={side === 'top' || side === 'bottom' ? 'Span the width' : 'Span the height'} />}
      {layout.overflowX && <StripNav layout={layout} focused={panes.focused} titles={titles} area={scroll.area} scroller={scroll.scroller} view={size.width} onScroll={scroll.scrollTo} />}
      {dragging !== null && (
        <div style={{ left: dragging.x + 12, top: dragging.y + 12 }} className="pointer-events-none fixed z-50 max-w-64 truncate rounded-[10px] border border-white/[0.12] bg-ink-850 px-2.5 py-1 text-[12.5px] text-ink-100 shadow-xl">
          {dragging.source.label}
        </div>
      )}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  )
}

/**
 * Shown on a split pane whose item draws no top bar of its own: drag it to move the pane, × to close
 * it. With an `inset` it is the one in the window row: as tall as the lights' band, starting past them.
 */
function PaneHeader({ title, focused, inset, onDrag, onClose }: { title: string; focused: boolean; inset: number | null; onDrag: (event: PointerEvent<HTMLElement>) => void; onClose: () => void }) {
  return (
    <div
      onPointerDown={onDrag}
      style={{ paddingLeft: inset ?? 12, transition: 'height var(--motion-panel) var(--motion-ease-panel), padding var(--motion-panel) var(--motion-ease-panel)' }}
      className={`flex ${inset === null ? 'h-7' : 'h-[44px]'} shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] pr-1 select-none active:cursor-grabbing ${focused ? 'bg-white/[0.04] text-ink-200' : 'text-ink-400'}`}
    >
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{title}</span>
      <button
        type="button"
        aria-label={`Close ${title} pane`}
        title="Close pane"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClose}
        className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.1] hover:text-ink-100"
      >
        <CloseIcon />
      </button>
    </div>
  )
}

/** Where the drop lands: tinted half of the pane for a split, the whole pane to replace or swap it, half the area to span a side. */
function DropPreview({ rect, label }: { rect: Rect; label: string }) {
  return (
    <span aria-hidden="true" style={percent(rect)} className="pointer-events-none absolute z-40 p-1.5">
      <span className={`flex size-full items-center justify-center rounded-[14px] border-2 border-accent/70 bg-accent/[0.14] text-[12px] font-medium text-ink-100`}>{label}</span>
    </span>
  )
}

/** The band along one edge of a split during a drag: a drop in it spans that whole side; lit while the pointer is in it. */
function SideBand({ edge, lit }: { edge: Edge; lit: boolean }) {
  const across = edge === 'top' || edge === 'bottom'
  const style: CSSProperties = across ? { left: 0, right: 0, height: sideBand, [edge]: 0 } : { top: 0, bottom: 0, width: sideBand, [edge]: 0 }
  return (
    <span
      aria-hidden="true"
      data-side-band={edge}
      style={style}
      className={`pointer-events-none absolute z-[47] transition-colors duration-100 ${lit ? 'bg-accent/45' : 'bg-accent/[0.1]'} ${across ? 'border-y' : 'border-x'} border-accent/30`}
    />
  )
}

/** Follows a press with pointer moves until release, the cursor held as `cursor` meanwhile. */
function track(cursor: string, onMove: (move: globalThis.PointerEvent) => void) {
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = cursor
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

/** A divider between two panes of a column: drag to resize (never under the minimum), double-click to equalise the split. */
function DividerHandle({ divider, column, offset, panes, onPanes }: { divider: Divider; column: StripColumn; offset: number; panes: Panes; onPanes: (change: (current: Panes) => Panes) => void }) {
  const row = divider.direction === 'row'
  const style: CSSProperties = row
    ? { left: column.x + divider.at * column.width - 4, top: divider.split.y * column.height - offset, height: divider.split.height * column.height, width: 8 }
    : { top: divider.at * column.height - offset - 4, left: column.x + divider.split.x * column.width, width: divider.split.width * column.width, height: 8 }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    // Each move resizes the tree from the drag's start, so the divider follows the pointer without drift.
    const startTree = panes
    const origin = row ? event.clientX : event.clientY
    const span = row ? divider.split.width * column.width : divider.split.height * column.height
    if (span <= 0) return
    const min = (row ? minPaneWidth : minPaneHeight) / span
    track(row ? 'col-resize' : 'row-resize', (move) => {
      const delta = ((row ? move.clientX : move.clientY) - origin) / span
      onPanes(() => resizeSplit(startTree, divider.splitId, divider.index, delta, min))
    })
  }

  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      title="Drag to resize · double-click to equalise"
      style={style}
      onPointerDown={start}
      onDoubleClick={() => onPanes((current) => equaliseSplit(current, divider.splitId))}
      className={`absolute z-40 ${row ? 'cursor-col-resize' : 'cursor-row-resize'} transition-colors hover:bg-accent/30`}
    />
  )
}

/** A column's right edge: drag to give it its own width (between its minimum and the area), double-click for the default. */
function ColumnEdge({ column, layout, root, strip, area, onStrip }: { column: StripColumn; layout: StripLayout; root: Panes['root']; strip: Strip; area: { width: number; height: number }; onStrip: (change: (strip: Strip) => Strip) => void }) {
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    // Each move sizes the column from the drag's start, so the edge follows the pointer without drift.
    const startStrip = strip
    const origin = event.clientX
    const startWidth = column.width
    track('col-resize', (move) => onStrip(() => resizeColumn(startStrip, root, column.id, startWidth + move.clientX - origin, area)))
  }
  const last = layout.columns.at(-1)?.id === column.id
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      title="Drag to resize the column · double-click for its default width"
      style={{ left: column.x + column.width - (last ? 8 : 4), top: 0, width: 8, height: '100%' }}
      onPointerDown={start}
      onDoubleClick={() => onStrip((current) => resetColumn(current, column.id))}
      className="absolute z-40 cursor-col-resize transition-colors hover:bg-accent/30"
    />
  )
}

/** Where a column taller than the area is scrolled to: a thin thumb on its right edge. */
function ColumnScrollbar({ column, offset, view }: { column: StripColumn; offset: number; view: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ left: column.x + column.width - 5, top: (offset / column.height) * view, height: (view / column.height) * view }}
      className="pointer-events-none absolute z-40 w-[3px] rounded-full bg-white/20"
    />
  )
}

/** How far the strip is scrolled sideways, following every scroll. */
function useScrollLeft(scroller: RefObject<HTMLDivElement | null>): number {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    const follow = () => setLeft(element.scrollLeft)
    follow()
    element.addEventListener('scroll', follow, { passive: true })
    return () => element.removeEventListener('scroll', follow)
  }, [scroller])
  return left
}

/** The column under the pointer while it is over the area, by its place in the strip. */
function useHoveredColumn(area: RefObject<HTMLDivElement | null>, scroller: RefObject<HTMLDivElement | null>, layout: StripLayout): string | null {
  const [hovered, setHovered] = useState<string | null>(null)
  const latest = useRef(layout)
  latest.current = layout
  useEffect(() => {
    const element = area.current
    if (element === null) return
    const onMove = (event: globalThis.PointerEvent) => {
      const bounds = element.getBoundingClientRect()
      setHovered(columnAt(latest.current, event.clientX - bounds.left + (scroller.current?.scrollLeft ?? 0)))
    }
    const onLeave = () => setHovered(null)
    element.addEventListener('pointermove', onMove, { passive: true })
    element.addEventListener('pointerleave', onLeave)
    return () => {
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerleave', onLeave)
    }
  }, [area, scroller])
  return hovered
}

function Chevron({ side }: { side: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={side === 'left' ? 'M10 3.5 5.5 8l4.5 4.5' : 'm6 3.5 4.5 4.5L6 12.5'} />
    </svg>
  )
}

/**
 * Ways through a strip wider than the area. A shadow on each edge with columns past it; hovering
 * the column at such an edge shows a round arrow there that brings one more column in. Along the top,
 * one segment per column: the focused one lit, the ones in view brighter, its title on hover, and a
 * click scrolls it into view.
 */
function StripNav({
  layout,
  focused,
  titles,
  area,
  scroller,
  view,
  onScroll,
}: {
  layout: StripLayout
  focused: string
  titles: Readonly<Record<string, string>>
  area: RefObject<HTMLDivElement | null>
  scroller: RefObject<HTMLDivElement | null>
  view: number
  onScroll: (x: number) => void
}) {
  const left = useScrollLeft(scroller)
  const hovered = useHoveredColumn(area, scroller, layout)
  const edges = stripEdges(layout, left, view)
  const arrow = (side: 'left' | 'right') => {
    const edge = edges[side]
    if (edge === null) return null
    const shown = hovered === edge.columnId
    const name = side === 'left' ? 'Previous column' : 'Next column'
    return (
      <button
        type="button"
        data-strip-arrow={side}
        aria-label={name}
        tabIndex={-1}
        onClick={() => onScroll(edge.scroll)}
        style={{ transitionDelay: shown ? '150ms' : '0ms' }}
        className={`absolute top-1/2 z-[46] grid size-8 -translate-y-1/2 place-items-center rounded-full border border-white/[0.12] bg-ink-850/90 text-ink-200 shadow-lg backdrop-blur transition-opacity duration-150 hover:bg-ink-800 hover:text-ink-100 ${side === 'left' ? 'left-2' : 'right-2'} ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <Chevron side={side} />
      </button>
    )
  }
  return (
    <>
      {edges.left !== null && <span aria-hidden="true" data-strip-shadow="left" className="pointer-events-none absolute inset-y-0 left-0 z-[41] w-6 bg-gradient-to-r from-black/35 to-transparent" />}
      {edges.right !== null && <span aria-hidden="true" data-strip-shadow="right" className="pointer-events-none absolute inset-y-0 right-0 z-[41] w-6 bg-gradient-to-l from-black/35 to-transparent" />}
      {arrow('left')}
      {arrow('right')}
      <div role="group" aria-label="Columns" className="absolute top-0 left-1/2 z-[45] flex -translate-x-1/2 gap-[3px]">
        {layout.columns.map((column, index) => {
          const lit = column.panes.some((pane) => pane.id === focused)
          const visible = Math.min(column.x + column.width, left + view) - Math.max(column.x, left) > column.width / 2
          const title = titles[column.id] ?? ''
          return (
            <button
              key={column.id}
              type="button"
              aria-label={`Show column ${index + 1}: ${title}`}
              onClick={() => onScroll(reveal(column.x, column.width, left, view, layout.width))}
              className="group/segment relative flex h-3 w-7 items-start pt-px focus-visible:outline-none"
            >
              <span
                className={`block h-1 w-full rounded-full transition-[height,background-color] duration-[var(--motion-enter)] group-hover/segment:h-1.5 group-focus-visible/segment:h-1.5 ${lit ? 'bg-accent/90' : visible ? 'bg-white/45 group-hover/segment:bg-white/70' : 'bg-white/[0.18] group-hover/segment:bg-white/50'}`}
              />
              <span className="pointer-events-none absolute top-full left-1/2 mt-1 max-w-56 -translate-x-1/2 truncate rounded-[8px] border border-white/[0.1] bg-ink-850 px-2 py-0.5 text-[11.5px] whitespace-nowrap text-ink-200 opacity-0 shadow-lg transition-opacity duration-100 group-hover/segment:opacity-100 group-hover/segment:delay-150 group-focus-visible/segment:opacity-100">
                {title}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}
