import { useContext, useMemo, useState } from 'react'
import { percentClass } from '@/advanced/usage-limits'
import { formatCommandOutput, isLongOutput, type OutputBlock, type OutputRow } from '@/chat/command-output'
import type { LimitTone } from '@/chat/composer-status'
import { formatText } from '@/chat/conversation-model'
import { MarkdownText } from '@/chat/markdown'
import { agentColor } from '@/components/agent-activity'
import { AgentIcon, ConversationAgent } from '@/components/agent-icons'

// A slash command's result in a conversation: the agent's mark and the command, then its output laid
// out by command-output.ts. A long result opens collapsed, with Show all.

// A meter's fill, as the sidebar's usage bars: neutral, then the theme's warning and critical tones.
const fillClass: Record<LimitTone, string> = { normal: 'bg-ink-300', amber: 'bg-warn', red: 'bg-bad' }

const percent = (value: number) => `${Math.round(value)}%`

/** Text with its `inline code` set apart, as a message shows it. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {formatText(text).map((segment, index) =>
        segment.type === 'text' ? (
          segment.value
        ) : (
          <code key={index} className="rounded-md bg-white/[0.08] px-1 py-0.5 font-mono text-[12.5px] text-ink-100">
            {segment.value}
          </code>
        ),
      )}
    </>
  )
}

function Meters({ rows }: { rows: Extract<OutputRow, { type: 'meter' }>[] }) {
  return (
    <ul className="grid grid-cols-[minmax(0,max-content)_minmax(64px,240px)_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
      {rows.map((row, index) => (
        <li key={index} className="contents" aria-label={`${row.label === '' ? '' : `${row.label}: `}${percent(row.percent)} used${row.note === null ? '' : `, ${row.note}`}`}>
          <span aria-hidden="true" className="truncate text-[13px] text-ink-200">{row.label}</span>
          <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <span className={`block h-full rounded-full ${fillClass[row.tone]}`} style={{ width: `${Math.max(2, Math.min(100, Math.round(row.percent)))}%` }} />
          </span>
          <span aria-hidden="true" className={`text-right text-[13px] font-semibold tabular-nums ${row.tone === 'normal' ? 'text-ink-100' : percentClass(row.tone)}`}>
            {percent(row.percent)}
          </span>
          <span aria-hidden="true" title={row.note ?? undefined} className="truncate text-[12px] text-ink-500">{row.note ?? ''}</span>
        </li>
      ))}
    </ul>
  )
}

function Fields({ rows }: { rows: Extract<OutputRow, { type: 'field' }>[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <dt className="text-ink-400">{row.label}</dt>
          <dd className="min-w-0 break-words text-ink-200 tabular-nums">
            <Inline text={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Shares({ rows }: { rows: Extract<OutputRow, { type: 'share' }>[] }) {
  return (
    <ul className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
      {rows.map((row, index) => (
        <li key={index} className="contents">
          <span className="text-right font-semibold text-ink-100 tabular-nums">{percent(row.percent)}</span>
          <span className="text-ink-300">
            <Inline text={row.text} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Consecutive rows of one kind, so each kind lines up in its own columns. */
function runs(rows: OutputRow[]): OutputRow[][] {
  const grouped: OutputRow[][] = []
  for (const row of rows) {
    const last = grouped.at(-1)
    if (last !== undefined && last[0]?.type === row.type) last.push(row)
    else grouped.push([row])
  }
  return grouped
}

function Rows({ rows }: { rows: OutputRow[] }) {
  const first = rows[0]
  if (first === undefined) return null
  if (first.type === 'meter') return <Meters rows={rows as Extract<OutputRow, { type: 'meter' }>[]} />
  if (first.type === 'field') return <Fields rows={rows as Extract<OutputRow, { type: 'field' }>[]} />
  if (first.type === 'share') return <Shares rows={rows as Extract<OutputRow, { type: 'share' }>[]} />
  return (
    <div className="space-y-1 text-[13.5px] leading-relaxed text-ink-200">
      {(rows as Extract<OutputRow, { type: 'text' }>[]).map((row, index) => (
        <p key={index} className="break-words">
          <Inline text={row.text} />
        </p>
      ))}
    </div>
  )
}

function Block({ block }: { block: OutputBlock }) {
  if (block.type === 'markdown') return <MarkdownText text={block.text} />
  if (block.type === 'code') return <pre className="overflow-x-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-200">{block.text}</pre>
  return (
    <section className="space-y-2">
      {block.title !== null && (
        <header className="flex items-baseline gap-3">
          <h3 className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{block.title}</h3>
          {block.detail !== null && <span className="text-[12px] text-ink-500 tabular-nums">{block.detail}</span>}
        </header>
      )}
      {runs(block.rows).map((run, index) => (
        <Rows key={index} rows={run} />
      ))}
    </section>
  )
}

/** `command` is what was run, slash included; "" when the record does not say. */
export function CommandOutput({ command, text }: { command: string; text: string }) {
  const agent = useContext(ConversationAgent)
  const blocks = useMemo(() => formatCommandOutput(text), [text])
  const long = isLongOutput(blocks)
  const [open, setOpen] = useState(false)
  const collapsed = long && !open
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-2 text-[13px]">
        {agent !== null && (
          <span aria-hidden="true" className="flex shrink-0" style={{ color: agentColor(agent) }}>
            <AgentIcon agent={agent} size={13} />
          </span>
        )}
        <span className={command === '' ? 'font-semibold text-ink-300' : 'font-mono text-[12.5px] font-semibold text-ink-200'}>{command === '' ? 'Command output' : command}</span>
      </div>
      {/* Collapsed, the result fades out at its foot whatever the background behind the card. */}
      <div className={`space-y-4 px-3.5 pb-3 ${collapsed ? 'max-h-[360px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}`}>
        {blocks.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </div>
      {long && (
        <div className="px-1 pb-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent hover:bg-white/[0.08]"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        </div>
      )}
    </div>
  )
}
