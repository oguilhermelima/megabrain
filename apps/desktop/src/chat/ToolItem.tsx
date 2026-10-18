import { useContext, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { LineCounts } from '@/github/parts'
import { editDiffs, editTotals } from '@/chat/edit-diff'
import { EditDiff } from '@/chat/EditDiff'
import { ToolIcon } from '@/chat/ToolIcon'
import { toolDetail, toolName, type ToolItem as ToolRow } from '@/chat/tool-groups'
import { clipText, toolLabel } from '@/chat/tool-sentence'
import { markMenu } from '@/chat/chat-menu'
import { toolCommand } from '@/chat/chat-menu-model'
import { LinkedText, PathLinksContext } from '@/chat/path-links'
import { firstPath } from '@/code/chat-paths'
import { WriteBasesContext } from '@/chat/WriteBasesContext'

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

export function StateMark({ state }: { state: 'running' | 'done' | 'failed' }) {
  if (state === 'running') return <span aria-label="running" className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-600 border-t-ink-300" />
  return (
    <svg viewBox="0 0 16 16" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-label={state === 'failed' ? 'failed' : 'finished'} className={`shrink-0 ${state === 'failed' ? 'text-warn' : 'text-ok/80'}`}>
      <path d={state === 'failed' ? 'M8 2.5 14 13H2ZM8 6.5v3M8 11.3v.2' : 'm3.5 8.5 3 3 6-7'} />
    </svg>
  )
}

const callState = (status: ToolRow['status']) => (status === 'running' ? 'running' : status === 'error' ? 'failed' : 'done')

export function CallText({ label, text, failed = false }: { label: string; text: string; failed?: boolean }) {
  const [full, setFull] = useState(false)
  const clip = clipText(text)
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03]">
      <div className={`px-3 pt-2 text-chat-label font-semibold tracking-[0.04em] uppercase ${failed ? 'text-warn' : 'text-ink-500'}`}>{label}</div>
      <pre className={`overflow-auto px-3 pt-1 pb-2.5 font-mono text-chat-code whitespace-pre-wrap text-ink-200 [overflow-wrap:anywhere] ${full ? 'max-h-96' : ''}`}>
        <LinkedText text={full ? text : clip.shown} />
      </pre>
      {clip.clipped && (
        <button type="button" onClick={() => setFull((value) => !value)} className="w-full border-t border-white/[0.05] px-3 py-1.5 text-left text-chat-small text-ink-400 hover:bg-white/[0.04] hover:text-ink-200">
          {full ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** One call: its tool and a short label; opened, its input and what came back. */
export function ToolItem({ item }: { item: ToolRow }) {
  const [open, setOpen] = useState(false)
  const input = item.call.tool?.input
  const name = toolName(item)
  const label = toolLabel(name, input) || toolDetail(item)
  const base = useContext(WriteBasesContext).get(item.id)
  const edits = useMemo(() => editDiffs(name, input, base), [name, input, base])
  const totals = edits === null ? null : editTotals(edits)
  const failed = item.status === 'error'
  const links = useContext(PathLinksContext)
  const target = links === null ? null : firstPath(toolDetail(item), links.root)
  const onContextMenu = (event: ReactMouseEvent) =>
    markMenu(event, { tool: { command: toolCommand(input), input: input === undefined ? null : prettyInput(input), output: item.result?.text ?? null } })
  return (
    <li onContextMenu={onContextMenu}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-chat-ui hover:bg-white/[0.04]">
          <ToolIcon name={name} status={item.status} size={13} />
          <span className="shrink-0 text-ink-300">{name}</span>
          <span title={toolDetail(item)} className="min-w-0 truncate font-mono text-chat-code text-ink-400">{label}</span>
          {totals !== null && <span className={failed ? 'opacity-50 grayscale' : ''}><LineCounts additions={totals.added} deletions={totals.removed} /></span>}
          <span className="ml-auto flex shrink-0 items-center pl-2"><StateMark state={callState(item.status)} /></span>
        </button>
        {links !== null && target !== null && (
          <button type="button" onClick={() => links.open(target.path, target.line)} title={`Open in Code: ${target.text}`} className="shrink-0 rounded-full px-2.5 py-1 text-chat-small font-semibold text-accent hover:bg-white/[0.08]">Open</button>
        )}
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-7 space-y-2">
          {edits !== null && <EditDiff files={edits} failed={failed} />}
          {edits === null && input !== undefined && input !== '' && <CallText label="Input" text={prettyInput(input)} />}
          {item.result !== null && item.result.text !== '' && (edits === null || failed) && <CallText label={failed ? 'Error' : 'Output'} text={item.result.text} failed={failed} />}
          {item.status === 'running' && <p className="text-chat-small text-ink-400">Running…</p>}
        </div>
      )}
    </li>
  )
}
