/** A prompt and a cursor: the mark of a terminal in the launcher and the sidebar. */
export function TerminalIcon({ size = 14, className = 'shrink-0' }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 4.5 3.5 3.5L3 11.5M8.5 12h4.5" />
    </svg>
  )
}
