import type { ReactNode } from 'react'
import { CodeIcon, IconButton } from '@/advanced/chrome'
import { AgentBadge } from '@/advanced/parts'
import { useOpenCode } from '@/chat/code-context'
import { useRunControls } from '@/run-panel/run-context'
import { RunButton, RunPanelToggle } from '@/run-panel/RunButton'

/**
 * The top bar every chat view and the launcher share: agent icon (none on the launcher), one-line title and one small metadata line, then
 * the view's own controls, then the code and run buttons of the chat's worktree on the right, with the run panel's toggle once anything ran. It sits about 12px below the window top; when the sidebar is
 * hidden the window's own drag strip above it clears the traffic lights.
 */
export function ChatHeader({ agent, title, meta, metaTitle, actions }: { agent: string | null; title: string; meta: string; metaTitle?: string; actions?: ReactNode }) {
  const root = useRunControls()?.root ?? null
  const openCode = useOpenCode()
  return (
    <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 pt-3 pb-2.5">
      {agent !== null && <AgentBadge agent={agent} size="md" />}
      <div className="min-w-0 flex-1">
        <h1 title={title} className="truncate text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
        <p title={metaTitle ?? meta} className="truncate text-[12px] leading-4 text-ink-400">{meta}</p>
      </div>
      {actions}
      {root !== null && openCode !== null && (
        <IconButton label="Open in Code" title={`Open ${root} in Code`} onClick={() => openCode(root)}>
          <CodeIcon />
        </IconButton>
      )}
      <RunButton />
      <RunPanelToggle />
    </header>
  )
}
