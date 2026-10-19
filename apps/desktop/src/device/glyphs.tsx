// The Device tab's 16px line glyphs: the zoom bar's and the device controls'.

const glyph = (path: string) => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)
export const glyphs: Record<string, ReturnType<typeof glyph>> = {
  home: glyph('M3 7.5 8 3l5 4.5V13H3z'),
  lock: glyph('M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2'),
  'volume-down': glyph('M3 6.5h2l3-2.5v8l-3-2.5H3zM11 8h3'),
  'volume-up': glyph('M3 6.5h2l3-2.5v8l-3-2.5H3zM11 8h3M12.5 6.5v3'),
  up: glyph('M4 10l4-4 4 4'),
  down: glyph('M4 6l4 4 4-4'),
  left: glyph('M10 4 6 8l4 4'),
  right: glyph('M6 4l4 4-4 4'),
  menu: glyph('M3 5h10M3 8h10M3 11h10'),
  'play-pause': glyph('M3.5 4v8l5-4zM10.5 4v8M13 4v8'),
  'zoom-out': glyph('M4 8h8'),
  'zoom-in': glyph('M4 8h8M8 4v8'),
  full: glyph('M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3'),
  select: glyph('M8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5'),
  rotate: glyph('M3.5 6.5A4.8 4.8 0 0 1 12 5M12 2.5V5H9.5M12.5 9.5A4.8 4.8 0 0 1 4 11M4 13.5V11h2.5'),
  screenshot: glyph('M2.5 5.5h2l1.2-1.8h4.6l1.2 1.8h2v7h-11zM8 7.2a2 2 0 1 0 0 4 2 2 0 0 0 0-4'),
  keyboard: glyph('M2 4.5h12v7H2zM4.5 7h.01M7 7h.01M9 7h.01M11.5 7h.01M5 9.5h6'),
  back: glyph('M10 4 6 8l4 4'),
  forward: glyph('M6 4l4 4-4 4'),
  reload: glyph('M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.6H9.9'),
  'exit-full': glyph('M6 3v3H3M13 6h-3V3M10 13v-3h3M3 10h3v3'),
}
