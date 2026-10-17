// One layout for the support panels on the right: the Knowledge topics, the Artifacts list and the
// artifact beside a chat. Measured from the panel's edge, after the left sidebar (Sidebar.tsx):
//
//   10px  the list's inset, both sides (4px plus the 6px scrollbar gutter at the right), so a row's
//         highlight sits 10px off each edge, rounded 12px, 32px tall
//   20px  where the header's title starts and where counts, ages and the header's last icon end:
//         the highlight's 10px plus 10px inside it, the same at both ends
//   64px  where every group's name and every row's text starts: a 14px slot for the chevron and a
//         14px slot for the mark, 8px apart, so a row (no chevron, maybe no mark) keeps the column
//
// The panel's surface is sidebarSurface (lib/panel-width.ts); its widths stay with each panel.

/** The panel's header: the page bar's height (12px above a 36px row, 10px below) and the list's inset. */
export const sidePanelHeader = 'flex shrink-0 pt-3 pr-2.5 pb-2.5 pl-2.5'

/** A slim header for a panel with no page bar beside it to line up with: 4px above and below the row. */
export const sidePanelBar = 'flex shrink-0 px-2.5 py-1'

/** The header's row: a title on the text column's 20px, its controls ending 20px from the edge. */
export const sidePanelHeaderRow = 'flex h-9 min-w-0 flex-1 items-center gap-2 px-2.5'

export const sidePanelTitle = 'min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-ink-300'

/** A 28px round icon button; the header's last one overhangs by its glyph's inset so the glyph ends on 20px. */
export const sidePanelButton =
  'grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 last:-mr-[6px] hover:bg-white/[0.08] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none'

/** The scrolling list under the header. */
export const sidePanelList = 'sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pt-1 pr-1 pb-3 pl-2.5'

/** A group's header: chevron, mark, name and count, in the section-header style of the left sidebar. */
export const sidePanelGroup = 'flex h-8 w-full items-center gap-2 rounded-[12px] px-2.5 text-left text-[13px] font-semibold text-ink-400 transition-colors select-none hover:text-ink-200'

/** A row under a group, highlighted when it is the one shown. */
export const sidePanelRow = (selected: boolean): string =>
  `flex h-8 w-full items-center gap-2 rounded-[12px] px-2.5 text-left text-[13px] transition-colors ${selected ? 'bg-row-selected text-ink-100' : 'text-ink-300 hover:bg-row-hover hover:text-ink-100'}`

/** The 14px slots before a name: the chevron's, then the mark's (empty in a row that has none). */
export const sidePanelSlot = 'grid size-3.5 shrink-0 place-items-center'

/** A row's count or age, at the right. */
export const sidePanelTrailing = 'shrink-0 text-[11px] whitespace-nowrap text-ink-400 tabular-nums'

/** A line in the list that is not a row: loading, nothing found. */
export const sidePanelNote = 'px-2.5 py-1 text-[12.5px] text-ink-400'
