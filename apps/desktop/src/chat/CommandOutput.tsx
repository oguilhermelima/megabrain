import { useContext, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { percentClass } from '@/advanced/usage-limits'
import { formatCommandOutput, isLongOutput, stripAnsi, type OutputBlock, type OutputRow } from '@/chat/command-output'
import { usageLimitTone, type LimitTone } from '@/chat/composer-status'
import type { InfoData } from '@/api/schema'
import { dataPanel, formatTokens, infoPanel, tokenCount, type ContextCategory, type ContextRow, type ContextSection, type InfoPanel, type Meter, type UsageSection } from '@/chat/info-panels'
import { formatText } from '@/chat/conversation-model'
import { MarkdownText } from '@/chat/markdown'
import { agentColor } from '@/components/agent-activity'
import { AgentIcon, ConversationAgent } from '@/components/agent-icons'

// A slash command's result in a conversation: the agent's mark and the command, then its output. An info
// command Claude prints (/usage, /context) shows as a panel read by info-panels.ts; anything else is laid
// out by command-output.ts, a long result cut short with Show all. Only the latest result opens by default;
// Copy and Show raw keep the text as the agent printed it.

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


// ---- /usage

// A panel's meter fills in the accent, then the theme's warning and critical tones past the usage thresholds.
const panelFillClass: Record<LimitTone, string> = { normal: 'bg-accent', amber: 'bg-warn', red: 'bg-bad' }

function UsageMeter({ meter }: { meter: Meter }) {
  return (
    <li aria-label={`${meter.label}: ${percent(meter.percent)} used${meter.reset === null ? '' : `, ${meter.reset}`}`} className="space-y-1">
      {meter.label !== '' && <div aria-hidden="true" className="text-[13px] font-semibold text-ink-100">{meter.label}</div>}
      <div aria-hidden="true" className="flex items-center gap-3">
        <span className="block h-1.5 max-w-[320px] min-w-[64px] flex-1 overflow-hidden rounded-full bg-white/[0.08]">
          <span className={`block h-full rounded-full ${panelFillClass[meter.tone]}`} style={{ width: `${Math.max(2, Math.min(100, Math.round(meter.percent)))}%` }} />
        </span>
        <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${meter.tone === 'normal' ? 'text-ink-100' : percentClass(meter.tone)}`}>{percent(meter.percent)} used</span>
      </div>
      {meter.reset !== null && <div aria-hidden="true" className="text-[12px] text-ink-500">{meter.reset}</div>}
    </li>
  )
}

function SectionTitle({ title, detail }: { title: string; detail: string | null }) {
  return (
    <header className="flex items-baseline gap-3">
      <h3 className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{title}</h3>
      {detail !== null && <span className="text-[12px] text-ink-500 tabular-nums">{detail}</span>}
    </header>
  )
}

function UsageSectionView({ section }: { section: UsageSection }) {
  if (section.type === 'fallback') return <>{section.blocks.map((block, index) => <Block key={index} block={block} />)}</>
  if (section.type === 'note') return <p className="text-[13px] text-ink-400"><Inline text={section.text} /></p>
  if (section.type === 'meters') {
    return (
      <ul className="space-y-3">
        {section.meters.map((meter, index) => <UsageMeter key={index} meter={meter} />)}
      </ul>
    )
  }
  if (section.type === 'insights') {
    return (
      <div className="space-y-0.5">
        <h3 className="text-[13px] font-semibold text-ink-100">{section.title}</h3>
        {section.note !== null && <p className="text-[12px] leading-relaxed text-ink-500">{section.note}</p>}
      </div>
    )
  }
  return (
    <section className="space-y-2">
      <SectionTitle title={section.title} detail={section.detail} />
      {section.shares.length > 0 && <Shares rows={section.shares.map((share) => ({ type: 'share', ...share }))} />}
      {section.fields.length > 0 && <Fields rows={section.fields.map((field) => ({ type: 'field', ...field }))} />}
    </section>
  )
}

// ---- /context

// A category's share of the window: the accent, full for the largest category and lighter for each smaller
// one; free space is the empty track and the autocompact buffer is striped, as neither holds anything yet.
const categoryStyle = (category: ContextCategory, rank: number): CSSProperties => {
  if (category.role === 'free') return { backgroundColor: 'rgb(255 255 255 / 0.08)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.16)' }
  if (category.role === 'buffer') return { backgroundImage: 'repeating-linear-gradient(135deg, var(--color-ink-500) 0 2px, transparent 2px 5px)' }
  if (category.role === 'deferred') return { boxShadow: 'inset 0 0 0 1px var(--color-ink-500)' }
  return { backgroundColor: `color-mix(in srgb, var(--color-accent) ${Math.max(35, 100 - rank * 13)}%, transparent)` }
}

function Categories({ section }: { section: Extract<ContextSection, { type: 'categories' }> }) {
  const inWindow = section.categories.filter((category) => category.role !== 'deferred')
  const deferred = section.categories.filter((category) => category.role === 'deferred')
  const bySize = section.categories.filter((category) => category.role === 'used').sort((a, b) => b.percent - a.percent)
  const styleOf = new Map(section.categories.map((category) => [category, categoryStyle(category, bySize.indexOf(category))]))
  const legend = (categories: ContextCategory[], muted: boolean) => (
    <ul className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] items-center gap-x-3 gap-y-1 text-[13px]">
      {categories.map((category) => (
        <li key={category.name} className="contents">
          <span aria-hidden="true" className="block size-2.5 rounded-[3px]" style={styleOf.get(category)} />
          <span className={`truncate ${muted ? 'text-ink-500' : 'text-ink-200'}`}>{category.name}</span>
          <span className="text-right text-ink-300 tabular-nums">{category.tokens}</span>
          <span className="w-12 text-right text-ink-500 tabular-nums">{category.percent.toFixed(1)}%</span>
        </li>
      ))}
    </ul>
  )
  return (
    <section className="space-y-3">
      <SectionTitle title={section.title} detail={null} />
      <div role="img" aria-label={inWindow.map((category) => `${category.name} ${category.percent}%`).join(', ')} className="flex h-2.5 w-full gap-px overflow-hidden rounded-full">
        {inWindow
          .filter((category) => category.percent > 0)
          .map((category) => (
            <span key={category.name} className="h-full min-w-[2px]" style={{ ...styleOf.get(category), flexGrow: category.percent, flexBasis: 0 }} />
          ))}
      </div>
      {legend(inWindow, false)}
      {deferred.length > 0 && (
        <div className="space-y-1">
          <div className="text-[12px] text-ink-500">Deferred, not in the window</div>
          {legend(deferred, true)}
        </div>
      )}
    </section>
  )
}

const totalOf = (rows: ContextRow[]) => {
  const counts = rows.map((row) => tokenCount(row.tokens))
  return formatTokens(counts.reduce((total, count) => total + (count?.value ?? 0), 0), counts.some((count) => count?.approximate === true))
}

/** A row's name without the `mcp__<server>__` prefix its group already names. */
const shortName = (row: ContextRow, group: string | null) => (group !== null && row.name.startsWith(`mcp__${group}__`) ? row.name.slice(`mcp__${group}__`.length) : row.name)

function ContextRows({ rows, group }: { rows: ContextRow[]; group: string | null }) {
  return (
    <ul className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)_max-content] items-baseline gap-x-3 gap-y-0.5 text-[12.5px]">
      {rows.map((row, index) => (
        <li key={index} className="contents">
          <span title={row.name} className="truncate font-mono text-[12px] text-ink-200">{shortName(row, group)}</span>
          <span title={row.detail} className="truncate text-ink-500">{group === null ? row.detail : ''}</span>
          <span className="text-right text-ink-300 tabular-nums">{row.tokens}</span>
        </li>
      ))}
    </ul>
  )
}

function RowsSection({ section }: { section: Extract<ContextSection, { type: 'rows' }> }) {
  return (
    <section className="space-y-2">
      <SectionTitle title={section.title} detail={`${section.rows.length} · ${totalOf(section.rows)} tokens`} />
      {section.groups === null ? (
        <ContextRows rows={section.rows} group={null} />
      ) : (
        <ul className="space-y-0.5">
          {section.groups.map((group) => (
            <li key={group.name}>
              <details className="group/row">
                <summary className="flex cursor-default list-none items-baseline gap-2 rounded-lg px-1 py-0.5 text-[13px] hover:bg-row-hover [&::-webkit-details-marker]:hidden">
                  <svg viewBox="0 0 16 16" width={10} height={10} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 self-center text-ink-500 transition-transform group-open/row:rotate-90">
                    <path d="m6 3.5 4.5 4.5L6 12.5" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate text-ink-200">{group.name}</span>
                  <span className="text-[12px] text-ink-500 tabular-nums">{group.rows.length}</span>
                  <span className="w-16 text-right text-ink-300 tabular-nums">{group.tokens}</span>
                </summary>
                <div className="py-1 pr-1 pl-5">
                  <ContextRows rows={group.rows} group={group.name} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ContextSectionView({ section }: { section: ContextSection }) {
  if (section.type === 'fallback') return <MarkdownText text={section.markdown} />
  if (section.type === 'categories') return <Categories section={section} />
  return <RowsSection section={section} />
}

function DataPanelView({ panel }: { panel: Extract<InfoPanel, { kind: 'data' }> }) {
  return (
    <>
      {panel.fields.length > 0 && <Fields rows={panel.fields.map((field) => ({ type: 'field', ...field }))} />}
      {panel.context !== null && (
        <section className="space-y-2">
          <SectionTitle title="Context window" detail={`${panel.context.used} / ${panel.context.window} tokens`} />
          <ul>
            <UsageMeter meter={{ label: '', percent: panel.context.percent, tone: panel.context.tone, reset: null }} />
          </ul>
        </section>
      )}
      {panel.meters.length > 0 && (
        <section className="space-y-2">
          <SectionTitle title="Limits" detail={null} />
          <ul className="space-y-3">
            {panel.meters.map((meter, index) => <UsageMeter key={index} meter={meter} />)}
          </ul>
        </section>
      )}
      {panel.cost !== null && (
        <section className="space-y-2">
          <SectionTitle title="Cost" detail={panel.cost.total} />
          {panel.cost.models.length > 0 && <Fields rows={panel.cost.models.map((model) => ({ type: 'field', ...model }))} />}
        </section>
      )}
      {panel.tokens.length > 0 && (
        <section className="space-y-2">
          <SectionTitle title="Tokens" detail={null} />
          <Fields rows={panel.tokens.map((field) => ({ type: 'field', ...field }))} />
        </section>
      )}
    </>
  )
}

function Panel({ panel }: { panel: InfoPanel }) {
  if (panel.kind === 'data') return <DataPanelView panel={panel} />
  if (panel.kind === 'usage') return <>{panel.sections.map((section, index) => <UsageSectionView key={index} section={section} />)}</>
  return (
    <>
      {(panel.model !== null || panel.tokens !== null) && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
          {panel.model !== null && <span className="font-mono text-[12.5px] text-ink-200">{panel.model}</span>}
          {panel.tokens !== null && (
            <span className="text-ink-400 tabular-nums">
              {panel.tokens.used} / {panel.tokens.total} tokens ·{' '}
              <span className={`font-semibold ${usageLimitTone(panel.tokens.percent) === 'normal' ? 'text-ink-100' : percentClass(usageLimitTone(panel.tokens.percent))}`}>{percent(panel.tokens.percent)}</span>
            </span>
          )}
        </div>
      )}
      {panel.sections.map((section, index) => <ContextSectionView key={index} section={section} />)}
    </>
  )
}

const actionClass = 'rounded-full px-2.5 py-1 text-[12px] font-semibold text-accent hover:bg-white/[0.08]'

/**
 * `command` is what was run, slash included; "" when the record does not say. `data` is what megabrain read
 * when it answered the command itself; the text shows when it holds nothing. `latest` opens the card; an
 * older result opens collapsed to its heading.
 */
export function CommandOutput({ command, text, data, latest = true }: { command: string; text: string; data?: InfoData; latest?: boolean }) {
  const agent = useContext(ConversationAgent)
  const panel = useMemo(() => (data === undefined ? null : dataPanel(data)) ?? infoPanel(command, text), [command, text, data])
  const blocks = useMemo(() => (panel === null ? formatCommandOutput(text) : []), [panel, text])
  const long = panel === null && isLongOutput(blocks)
  const [toggled, setToggled] = useState<boolean | null>(null)
  const [all, setAll] = useState(false)
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])
  const open = toggled ?? latest
  const collapsed = long && !all && !raw
  const copy = () => void navigator.clipboard.writeText(stripAnsi(text)).then(() => setCopied(true), () => {})
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-center gap-1 pt-1.5 pr-1.5 pb-1 pl-2">
        <button type="button" onClick={() => setToggled(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-white/[0.04]">
          <svg viewBox="0 0 16 16" width={10} height={10} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>
            <path d="m6 3.5 4.5 4.5L6 12.5" />
          </svg>
          {agent !== null && (
            <span aria-hidden="true" className="flex shrink-0" style={{ color: agentColor(agent) }}>
              <AgentIcon agent={agent} size={13} />
            </span>
          )}
          <span className={command === '' ? 'font-semibold text-ink-300' : 'font-mono text-[12.5px] font-semibold text-ink-200'}>{command === '' ? 'Command output' : command}</span>
        </button>
        {open && (
          <>
            <button type="button" onClick={copy} className={actionClass}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" onClick={() => setRaw((value) => !value)} aria-pressed={raw} className={actionClass}>
              {raw ? 'Show panel' : 'Show raw'}
            </button>
          </>
        )}
      </div>
      {open && (
        <>
          {/* Collapsed, the result fades out at its foot whatever the background behind the card. */}
          <div className={`space-y-4 px-3.5 pt-1 pb-3 ${collapsed ? 'max-h-[360px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}`}>
            {raw ? (
              <pre className="overflow-x-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-200">{stripAnsi(text)}</pre>
            ) : panel !== null ? (
              <Panel panel={panel} />
            ) : (
              blocks.map((block, index) => <Block key={index} block={block} />)
            )}
          </div>
          {long && !raw && (
            <div className="px-1 pb-2">
              <button type="button" onClick={() => setAll((value) => !value)} aria-expanded={all} className={actionClass}>
                {all ? 'Show less' : 'Show all'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
