import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { ArrangeTarget } from '@/panes/arrange'
import type { RowDragState } from '@/advanced/useRowDrag'
import type { KeyedItem } from '@/advanced/row-model'
import { terminalLabel } from '@/terminal/terminal-list'
import type { DropPlacement, SidebarFolder } from '@/advanced/sidebar-folders'
import { projectColor } from '@/advanced/picture-model'
import { MenuIconGlyph } from '@/components/menu-icons'
import { Collapse } from '@/components/Collapse'
import type { MenuItem } from '@/components/ContextMenu'
import { MoreButton, RowActions, type MenuOpener } from '@/advanced/SidebarRows'

/** An entry for one of the app's pages (Artifacts, Knowledge, Tasks) above the Projects header, padded and shaped like a project row. */
export function PageEntry({ label, icon, selected, onOpen }: { label: string; icon: ReactNode; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'page' : undefined}
      className={`flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 text-left transition-colors select-none ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`}
    >
      <span className="grid size-6 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em]">{label}</span>
    </button>
  )
}

/** What a drop on the hover's map does, in words. */
function arrangeNote(target: ArrangeTarget): string {
  if (target.kind === 'side') return target.side === 'top' || target.side === 'bottom' ? `Span the width, ${target.side === 'top' ? 'on top' : 'at the bottom'}` : `Span the height, on the ${target.side}`
  return target.zone === 'center' ? 'Swap panes' : 'Split beside'
}

/** What a dragged group or member carries, by the pointer; a row dragged out of its group says it leaves. */
export function DragGhost({ state }: { state: RowDragState }) {
  const target = state.target
  const note = target?.kind === 'leave' ? 'Remove from split' : target?.kind === 'join' ? 'Join split' : target?.kind === 'arrange' ? arrangeNote(target.target) : null
  return (
    <div style={{ left: state.x + 12, top: state.y + 12 }} className="pointer-events-none fixed z-[70] max-w-64 rounded-[10px] border border-white/[0.12] bg-ink-850 px-2.5 py-1 text-[12.5px] text-ink-100 shadow-xl">
      {note !== null && <div className="text-[11px] font-medium text-accent">{note}</div>}
      <div className="truncate">{state.source.label}</div>
    </div>
  )
}

/** A row's title, for what a drag carries. */
export const rowLabel = (item: KeyedItem) => (item.kind === 'native' ? (item.chat.title ?? 'New chat') : item.kind === 'terminal' ? terminalLabel(item.terminal) : item.session.title)

/** A row a dragged row would join into a split: ringed, with the split glyph at its right. */
export function JoinMark() {
  return (
    <span aria-hidden="true" className="motion-fade pointer-events-none absolute inset-0 z-10 flex items-center justify-end rounded-[12px] bg-accent/[0.12] pr-2 ring-2 ring-accent ring-inset">
      <span className="flex items-center gap-1 rounded-[6px] bg-ink-850/90 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
        <MenuIconGlyph icon="splitRight" />
        Split
      </span>
    </span>
  )
}

/** The line that shows where a dragged project or folder lands; dropping into a folder rings its header. */
export function DropLine({ edge }: { edge: DropPlacement }) {
  if (edge === 'into') return <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[12px] ring-2 ring-accent ring-inset" />
  return <span aria-hidden="true" className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent ${edge === 'before' ? '-top-1' : '-bottom-1'}`} />
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {open ? <path d="M1.8 4.2c0-.6.4-1 1-1h3.1l1.4 1.5h5.1c.6 0 1 .4 1 1v.8H4.6c-.5 0-.9.3-1 .7L1.8 12.3Zm1.9 2.9c.1-.4.5-.6.9-.6h9.6c.6 0 1 .6.8 1.1l-1.4 4.2c-.1.4-.5.7-1 .7H2.8" /> : <path d="M1.8 4.2c0-.6.4-1 1-1h3.1l1.4 1.5h5.9c.6 0 1 .4 1 1v6.1c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" />}
    </svg>
  )
}

/** A folder's tile: the size and tint of a project's letter badge, so the two kinds of row line up. */
function FolderTile({ folder, open }: { folder: SidebarFolder; open: boolean }) {
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(folder.name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-white">
      <FolderIcon open={open} />
    </span>
  )
}

/**
 * A folder the person made to group projects: its header folds it, renames inline, drags among the
 * projects at the top level and takes projects dropped on it; its projects sit under it.
 */
export function FolderSection({
  folder,
  count,
  renaming,
  onStartRename,
  onRename,
  onToggle,
  drag,
  dragging,
  edge,
  menuItems,
  onMenu,
  children,
}: {
  folder: SidebarFolder
  /** Projects shown in it. */
  count: number
  renaming: boolean
  onStartRename: () => void
  /** The new name, or null to stop renaming without one. */
  onRename: (name: string | null) => void
  onToggle: () => void
  drag: ProjectDrag
  dragging: boolean
  edge: DropPlacement | null
  menuItems: MenuItem[]
  onMenu: MenuOpener
  children: ReactNode
}) {
  const open = !folder.collapsed
  return (
    <section data-folder-id={folder.id} className={`relative ${dragging ? 'opacity-50' : ''}`}>
      <div
        data-entry-key={folder.id}
        data-entry-folder=""
        data-entry-open={open ? '' : undefined}
        onContextMenu={renaming ? undefined : (event) => onMenu(event, menuItems)}
        onPointerDown={renaming ? undefined : (event) => drag.start(event, folder.id)}
        className="group relative flex items-center gap-0.5 rounded-[12px] pr-1.5 transition-colors select-none hover:bg-row-hover"
      >
        {edge !== null && <DropLine edge={edge} />}
        {renaming ? (
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5">
            <FolderTile folder={folder} open={open} />
            <input
              aria-label={`Rename ${folder.name}`}
              defaultValue={folder.name}
              maxLength={200}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename(event.currentTarget.value)
                if (event.key === 'Escape') onRename(null)
              }}
              onBlur={(event) => onRename(event.currentTarget.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold tracking-[-0.01em] text-ink-100 outline-none"
            />
          </div>
        ) : (
          <button
            type="button"
            data-entry-toggle={folder.id}
            onClick={onToggle}
            onDoubleClick={onStartRename}
            onKeyDown={(event) => drag.key(event, folder.id)}
            aria-expanded={open}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            title={`${folder.name}\nDrag or press ⌥↑ ⌥↓ to reorder; drop projects on it to group them`}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
          >
            <FolderTile folder={folder} open={open} />
            <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink-100">{folder.name}</h2>
            <span title={`${count} ${count === 1 ? 'project' : 'projects'}`} className="shrink-0 text-[11px] font-medium text-ink-400 tabular-nums">
              {count}
            </span>
          </button>
        )}
        {!renaming && (
          <RowActions gap="0.5">
            <MoreButton label={`Manage ${folder.name}`} onClick={(event) => onMenu(event, menuItems)} />
          </RowActions>
        )}
      </div>
      <Collapse open={open}>
        <div className="space-y-1 pt-1 pl-3">{children}</div>
      </Collapse>
    </section>
  )
}

/** What a project row needs to be dragged or moved with the keyboard; the same object every render. */
export interface ProjectDrag {
  start: (event: PointerEvent<HTMLElement>, path: string) => void
  key: (event: KeyboardEvent<HTMLElement>, path: string) => void
}

/** The release that ends a drag must not also toggle or open the row it lands on. */
export function swallowNextClick() {
  const swallow = (event: globalThis.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

