// One horizontal inset for the main content column, the pane's top bar's (chat/ChatHeader): its title and
// tabs start 24px from the column's left edge and its last control ends 24px from the right. Every page's
// bar, body, composer and empty states start and end on those edges. Side panels keep their own metrics
// (lib/side-panel.ts); a page that centres a reading column keeps it centred and puts only its bar and
// full-width parts on the inset. A control whose hover fill reaches past its glyph overhangs the edge by
// that fill, as the side panels' last buttons do, so the glyph is what lines up.

/** The inset in pixels, for an inline style that animates it (the top bar's left padding slides with the sidebar). */
export const pageInset = 24

/** The inset as padding on both sides. */
export const pageX = 'px-6'

/** The inset as margin on both sides, for a block that paints its own box or scrolls. */
export const pageMx = 'mx-6'

/** The inset at the left only, for a column whose other side keeps its own spacing. */
export const pageLeft = 'pl-6'

/** The inset at the right only, for a bar whose left padding is set inline. */
export const pageRight = 'pr-6'
