import { useRef, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { equaliseSplit, paneRects, resizeSplit, zonePreview, type Divider, type Panes, type Rect } from '@/panes/pane-model'
import type { PaneDrag } from '@/panes/usePaneDrag'

/** What a pane shows for its item: the title on its header, and the view. */
export interface PaneContent {
  title: string
  node: ReactNode
}

/** The smallest a pane may be dragged to, in pixels. */
const minWidth = 240
const minHeight = 140

const percent = (rect: Rect): CSSProperties => ({ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` })

/**
 * The main area as panes. Every view is placed absolutely by its share of the area and keyed by its
 * item, so splitting, moving or resizing never remounts it: a draft, a scroll position and a
 * terminal's screen survive. Items in `background` stay mounted but hidden (terminals keep running
 * and report their exit while no pane shows them).
 */
export function PaneArea({
  panes,
  onPanes,
  background,
  render,
  drag,
  onClose,
}: {
  panes: Panes
  onPanes: (change: (current: Panes) => Panes) => void
  background: readonly string[]
  render: (item: string) => PaneContent
  drag: PaneDrag
  onClose: (paneId: string) => void
}) {
  const area = useRef<HTMLDivElement>(null)
  const { panes: rects, dividers } = paneRects(panes.root)
  const split = rects.length > 1
  const dragging = drag.state
  const target = dragging?.target ?? null
  // Dropping a pane on itself, or an item on the pane that shows it, does nothing, so it shows no preview.
  const source = dragging?.source ?? null
  const targetItem = target === null ? null : (rects.find((pane) => pane.id === target.paneId)?.item ?? null)
  const preview = target !== null && source !== null && !(source.kind === 'pane' ? source.paneId === target.paneId : source.item === targetItem) ? target : null

  const focus = (paneId: string) => {
    if (paneId !== panes.focused) onPanes((current) => ({ ...current, focused: paneId }))
  }

  const slots: { item: string; pane: (typeof rects)[number] | null }[] = [...rects.map((pane) => ({ item: pane.item, pane })), ...background.map((item) => ({ item, pane: null }))]
  // React keeps a keyed child only among the same siblings, so every slot renders here in one stable order.
  slots.sort((left, right) => (left.item < right.item ? -1 : left.item > right.item ? 1 : 0))

  return (
    <div ref={area} className="relative min-h-0 flex-1">
      {slots.map(({ item, pane }) => {
        const content = render(item)
        const focused = pane !== null && split && pane.id === panes.focused
        return (
          <section
            key={item}
            data-pane-id={pane?.id}
            aria-label={pane === null ? undefined : content.title}
            onPointerDownCapture={pane === null ? undefined : () => focus(pane.id)}
            style={pane === null ? undefined : percent(pane.rect)}
            className={pane === null ? 'hidden' : `absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${pane.rect.x > 0 ? 'border-l border-white/[0.07]' : ''} ${pane.rect.y > 0 ? 'border-t border-white/[0.07]' : ''}`}
          >
            {split && pane !== null && <PaneHeader title={content.title} focused={pane.id === panes.focused} onDrag={(event) => drag.start(event, { kind: 'pane', paneId: pane.id, label: content.title })} onClose={() => onClose(pane.id)} />}
            <div className="flex min-h-0 flex-1 flex-col">{content.node}</div>
            {focused && <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 ring-1 ring-accent/50 ring-inset" />}
            {pane !== null && preview?.paneId === pane.id && <DropPreview rect={zonePreview(preview.zone)} replace={preview.zone === 'center'} />}
          </section>
        )
      })}
      {dividers.map((divider) => (
        <DividerHandle key={`${divider.splitId}:${divider.index}`} divider={divider} panes={panes} area={area} onPanes={onPanes} />
      ))}
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

/** Shown on every pane once the area is split: drag it to move the pane, × to close it. */
function PaneHeader({ title, focused, onDrag, onClose }: { title: string; focused: boolean; onDrag: (event: PointerEvent<HTMLElement>) => void; onClose: () => void }) {
  return (
    <div onPointerDown={onDrag} title={`${title}\nDrag to move this pane`} className={`flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] pr-1 pl-3 select-none active:cursor-grabbing ${focused ? 'bg-white/[0.04] text-ink-200' : 'text-ink-400'}`}>
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

/** Where the drop lands: tinted half of the pane for a split, the whole pane to replace it. */
function DropPreview({ rect, replace }: { rect: Rect; replace: boolean }) {
  return (
    <span aria-hidden="true" style={percent(rect)} className="pointer-events-none absolute z-20 p-1.5">
      <span className={`flex size-full items-center justify-center rounded-[14px] border-2 border-accent/70 bg-accent/[0.14] text-[12px] font-medium text-ink-100`}>{replace ? 'Replace' : 'Split here'}</span>
    </span>
  )
}

/** A divider between two panes: drag to resize (never under the minimum), double-click to equalise the split. */
function DividerHandle({ divider, panes, area, onPanes }: { divider: Divider; panes: Panes; area: RefObject<HTMLDivElement | null>; onPanes: (change: (current: Panes) => Panes) => void }) {
  const row = divider.direction === 'row'
  const style: CSSProperties = row
    ? { left: `calc(${divider.at * 100}% - 4px)`, top: `${divider.split.y * 100}%`, height: `${divider.split.height * 100}%`, width: 8 }
    : { top: `calc(${divider.at * 100}% - 4px)`, left: `${divider.split.x * 100}%`, width: `${divider.split.width * 100}%`, height: 8 }

  const start = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = area.current?.getBoundingClientRect()
    if (event.button !== 0 || bounds === undefined) return
    event.preventDefault()
    // Each move resizes the tree from the drag's start, so the divider follows the pointer without drift.
    const startTree = panes
    const origin = row ? event.clientX : event.clientY
    const span = row ? divider.split.width * bounds.width : divider.split.height * bounds.height
    if (span <= 0) return
    const min = (row ? minWidth : minHeight) / span
    const onMove = (move: globalThis.PointerEvent) => {
      const delta = ((row ? move.clientX : move.clientY) - origin) / span
      onPanes(() => resizeSplit(startTree, divider.splitId, divider.index, delta, min))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = row ? 'col-resize' : 'row-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
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
      className={`absolute z-30 ${row ? 'cursor-col-resize' : 'cursor-row-resize'} transition-colors hover:bg-accent/30`}
    />
  )
}
