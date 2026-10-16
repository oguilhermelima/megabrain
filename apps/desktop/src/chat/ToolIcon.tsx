import type { ToolStatus } from '@/chat/conversation-model'
import { toolIconLook, type ToolKind } from '@/chat/tool-icons'

// The glyph of a tool call (see tool-icons.ts), on the 16-unit grid and 1.5 stroke of the app's other
// icons (components/menu-icons.tsx).

const paths: Record<ToolKind, string> = {
  terminal: 'm3 4.5 3.5 3.5L3 11.5M8.5 12h4.5',
  file: 'M4 2h5l3.5 3.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM9 2v3.5h3.5',
  edit: 'M10.5 2.5 13.5 5.5 6 13H3v-3ZM9 4l3 3',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9M10.3 10.3l3.2 3.2',
  web: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2M2 8h12M8 2c-2.2 2-2.2 10 0 12M8 2c2.2 2 2.2 10 0 12',
  subagent:
    'M8 2a1.75 1.75 0 1 0 0 3.5A1.75 1.75 0 1 0 8 2M4 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5M12 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5M8 5.5V8M4 10.5v-1A1.5 1.5 0 0 1 5.5 8h5A1.5 1.5 0 0 1 12 9.5v1',
  mcp: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0ZM8 11v3',
  tool: 'M10.5 2.2a3.3 3.3 0 0 0-3.1 4.4l-4.8 4.8a1.4 1.4 0 0 0 2 2l4.8-4.8a3.3 3.3 0 0 0 4.4-3.1l-2 2-1.8-.5-.5-1.8Z',
}

export function ToolIcon({ name, status, size = 14 }: { name: string; status: ToolStatus; size?: number }) {
  const look = toolIconLook(name, status)
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-tool-kind={look.kind}
      className={`shrink-0 ${look.tone === 'error' ? 'text-bad' : 'text-ink-400'} ${look.pulse ? 'motion-safe:animate-pulse' : ''}`}
    >
      <path d={paths[look.kind]} />
    </svg>
  )
}
