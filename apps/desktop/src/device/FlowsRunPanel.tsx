import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { PlusIcon } from '@/advanced/chrome'
import { api } from '@/api'
import type { MaestroFlow, MaestroRun } from '@/api/schema'
import type { SegmentOf } from '@/chat/action-bar-model'
import { PanelIcon } from '@/advanced/WikiShell'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { Spinner } from '@/components/ui'
import { durationLabel, groupFlows, historyRows, isActive, needsInstall, newFlowName, type RunState, type StepRow } from '@/device/device-model'
import { moduleRetryArgs } from '@/onboarding/model'
import { sidePanelBar, sidePanelButton, sidePanelGroup, sidePanelHeaderRow, sidePanelList, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTrailing } from '@/lib/side-panel'

const docsUrl = 'https://docs.maestro.dev'

export type Load<T> = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; value: T }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type PanelTab = 'flows' | 'run'

/**
 * The Device tab's right panel, laid out as every support panel is (lib/side-panel): Flows and Run as
 * two tabs under one header that also carries Run (or Stop), so the flow picked in one tab runs from
 * either. A run that starts brings its tab forward.
 */
export function FlowsRunPanel({
  root,
  flows,
  chosen,
  onChoose,
  onCreated,
  run,
  rows,
  history,
  canRun,
  selected,
  onSelect,
  onRun,
  onStop,
  onHide,
}: {
  root: string
  flows: Load<MaestroFlow[]>
  chosen: string | null
  onChoose: (path: string) => void
  onCreated: (path: string) => void
  run: RunState
  rows: StepRow[]
  history: MaestroRun[]
  canRun: boolean
  selected: number | null
  onSelect: (index: number | null) => void
  onRun: () => void
  onStop: () => void
  /** Hides the panel; absent where it cannot hide. */
  onHide?: () => void
}) {
  const active = isActive(run)
  const [tab, setTab] = useState<PanelTab>(active ? 'run' : 'flows')
  useEffect(() => {
    if (run.phase === 'queued') setTab('run')
  }, [run.phase])
  const count = flows.kind === 'ready' ? flows.value.length : null
  const segments: SegmentOf<PanelTab>[] = [
    {
      view: 'flows',
      label: 'Flows',
      enabled: true,
      title: 'The worktree’s Maestro flows',
      badge: count === null || count === 0 ? null : String(count),
    },
    {
      view: 'run',
      label: 'Run',
      enabled: true,
      title: 'The run’s steps and the history',
      badge: null,
    },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={sidePanelBar}>
        <div className={sidePanelHeaderRow}>
          <div className="min-w-0 flex-1">
            <SegmentedTabs label="Flows and runs" segments={segments} shown={tab} onSelect={setTab} />
          </div>
          {active ? (
            <button
              type="button"
              onClick={onStop}
              disabled={run.stopping}
              aria-label="Stop flow"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-bad/40 bg-bad/10 px-3 text-[12px] font-semibold text-bad transition-colors hover:bg-bad/20 disabled:opacity-50"
            >
              <StopIcon /> {run.stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              aria-label="Run flow"
              title={chosen === null ? 'Choose a flow' : `Run ${chosen}`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[12px] font-semibold text-accent-ink transition-colors hover:bg-[#a3aeff] disabled:bg-white/[0.06] disabled:text-ink-500"
            >
              <PlayIcon /> Run
            </button>
          )}
          {onHide !== undefined && (
            <button type="button" onClick={onHide} aria-label="Hide flows" title="Hide flows" className={sidePanelButton}>
              <PanelIcon />
            </button>
          )}
        </div>
      </div>
      <div style={{ scrollbarGutter: 'stable' }} className={sidePanelList}>
        {tab === 'flows' ? <FlowsTab root={root} flows={flows} chosen={chosen} locked={active} onChoose={onChoose} onCreated={onCreated} /> : <RunTab run={run} rows={rows} history={history} flow={chosen} selected={selected} onSelect={onSelect} />}
      </div>
    </div>
  )
}

const field = 'h-8 w-full min-w-0 rounded-[12px] border border-white/[0.1] bg-white/[0.04] px-2.5 text-[13px] text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent/60'

function FlowsTab({ root, flows, chosen, locked, onChoose, onCreated }: { root: string; flows: Load<MaestroFlow[]>; chosen: string | null; locked: boolean; onChoose: (path: string) => void; onCreated: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const list = flows.kind === 'ready' ? flows.value : []
  const groups = groupFlows(list, query)

  const create = (event: FormEvent) => {
    event.preventDefault()
    const valid = newFlowName(name)
    if (valid === null) {
      setCreateError('Use letters, digits, - and _.')
      return
    }
    setCreating(true)
    api
      .maestroNewFlow(root, valid)
      .then((path) => {
        setNaming(false)
        setName('')
        setCreateError(null)
        onCreated(path)
      })
      .catch((error: unknown) => setCreateError(message(error)))
      .finally(() => setCreating(false))
  }

  return (
    <>
      {/* An empty worktree offers New flow in its explanation instead. */}
      {(list.length > 0 || naming) && (
        <div className="flex items-center gap-1 pb-1">
          {list.length > 0 ? <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search flows" aria-label="Search flows" className={field} /> : <span className="min-w-0 flex-1" />}
          <button type="button" onClick={() => setNaming((current) => !current)} aria-expanded={naming} aria-label="New flow" title="New flow" className={`${sidePanelButton} ${naming ? 'bg-white/[0.08] text-ink-100' : ''}`}>
            <PlusIcon />
          </button>
        </div>
      )}
      {naming && (
        <form onSubmit={create} className="px-2.5 pt-1 pb-2">
          <label className="mb-1.5 block text-[12px] leading-4 text-ink-400" htmlFor="device-new-flow">
            Creates .maestro/
            <span className="text-ink-200">{newFlowName(name) ?? 'name'}</span>
            .yaml and opens it in Code
          </label>
          <div className="flex gap-1.5">
            <input id="device-new-flow" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="checkout" className={field} />
            <button type="submit" disabled={creating} className="h-8 shrink-0 rounded-[12px] bg-accent px-3 text-[12px] font-semibold text-accent-ink disabled:bg-ink-700 disabled:text-ink-400">
              Create
            </button>
          </div>
          {createError !== null && <p className="mt-1.5 text-[12px] text-bad">{createError}</p>}
        </form>
      )}
      {flows.kind === 'loading' && <p className={sidePanelNote}>Reading flows…</p>}
      {flows.kind === 'error' && <p className={`${sidePanelNote} text-bad select-text`}>{message(flows.error)}</p>}
      {flows.kind === 'ready' && list.length === 0 && !naming && (
        <div className="px-2.5 py-1 text-[12.5px] leading-5 text-ink-400">
          <p className="font-medium text-ink-200">No flows in this worktree yet</p>
          <p className="mt-1">
            Maestro flows are YAML files in a <span className="font-mono text-[11.5px] text-ink-300">.maestro</span> or <span className="font-mono text-[11.5px] text-ink-300">maestro</span> folder at the worktree’s root. Each one lists steps like
            launching the app, tapping and asserting text.
          </p>
          <div className="mt-2.5 flex items-center gap-3">
            <button type="button" onClick={() => setNaming(true)} className="font-medium text-ink-100 hover:underline">
              New flow
            </button>
            <button type="button" onClick={() => void api.openUrl(docsUrl)} className="font-medium text-accent hover:underline">
              Read the Maestro docs
            </button>
          </div>
        </div>
      )}
      {flows.kind === 'ready' && list.length > 0 && groups.length === 0 && <p className={sidePanelNote}>No flow matches “{query}”.</p>}
      {groups.map((group) => (
        <section key={group.folder} aria-label={group.folder}>
          <div className={`${sidePanelGroup} pointer-events-none`}>
            <span aria-hidden="true" className={sidePanelSlot}>
              <FolderIcon />
            </span>
            <span className="min-w-0 flex-1 truncate">{group.folder}</span>
            <span className="shrink-0 text-[11px] font-medium tabular-nums">{group.flows.length}</span>
          </div>
          <div className="space-y-0.5 pt-0.5 pb-2">
            {group.flows.map((entry) => {
              const current = entry.path === chosen
              return (
                <button
                  key={entry.path}
                  type="button"
                  disabled={locked && !current}
                  onClick={() => onChoose(entry.path)}
                  aria-current={current || undefined}
                  title={entry.appId === null ? entry.path : `${entry.path}\n${entry.appId}`}
                  className={`${sidePanelRow(current)} disabled:opacity-50`}
                >
                  <span aria-hidden="true" className={sidePanelSlot} />
                  <span aria-hidden="true" className={sidePanelSlot} />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}

const phaseLabel: Record<RunState['phase'], string> = {
  idle: 'Not run yet',
  queued: 'Waiting for a slot…',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  stopped: 'Stopped',
}

const phaseTone: Record<RunState['phase'], string> = {
  idle: 'text-ink-400',
  queued: 'text-warn',
  running: 'text-accent',
  passed: 'text-ok',
  failed: 'text-bad',
  stopped: 'text-ink-300',
}

function GroupTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className={`${sidePanelGroup} pointer-events-none`}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="shrink-0 text-[11px] font-medium tabular-nums">{count}</span>}
    </div>
  )
}

function RunTab({ run, rows, history, flow, selected, onSelect }: { run: RunState; rows: StepRow[]; history: MaestroRun[]; flow: string | null; selected: number | null; onSelect: (index: number | null) => void }) {
  const active = isActive(run)
  const [installing, setInstalling] = useState(false)
  const [installNote, setInstallNote] = useState<string | null>(null)
  const install = () => {
    setInstalling(true)
    api
      .installModule(moduleRetryArgs('simulator-maestro'))
      .then((result) => setInstallNote(result.ok ? 'Maestro is installed. Run the flow again.' : result.message))
      .catch((error: unknown) => setInstallNote(message(error)))
      .finally(() => setInstalling(false))
  }
  const shownFlow = run.flow ?? flow

  return (
    <>
      <div className="mx-0 mb-2 rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
        <p className={`flex items-center gap-1.5 text-[12.5px] font-medium ${phaseTone[run.phase]}`}>
          {active && <Spinner />}
          {phaseLabel[run.phase]}
          {run.durationMs !== null && !active && <span className="ml-auto text-[11px] font-normal text-ink-400 tabular-nums">{durationLabel(run.durationMs)}</span>}
        </p>
        {shownFlow !== null && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-400" title={shownFlow}>
            {shownFlow}
          </p>
        )}
        {rows.length === 0 && run.phase === 'idle' && <p className="mt-1 text-[12px] leading-5 text-ink-400">Pick a flow and a device, then Run. Each step shows here as Maestro finishes it.</p>}
      </div>
      {run.error !== null && (
        <div className="mb-2 rounded-[12px] border border-bad/30 bg-bad/10 px-2.5 py-2 text-[12px] leading-5 text-bad">
          <p className="select-text">{run.error}</p>
          {needsInstall(run.error) && (
            <button type="button" onClick={install} disabled={installing} className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.1] px-3 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.16] disabled:opacity-60">
              {installing && <Spinner />} {installing ? 'Installing Maestro…' : 'Install Maestro'}
            </button>
          )}
          {installNote !== null && <p className="mt-1.5 text-ink-200">{installNote}</p>}
        </div>
      )}
      {rows.length > 0 && (
        <section aria-label="Steps">
          <GroupTitle count={rows.length}>Steps</GroupTitle>
          <ol className="space-y-0.5 pt-0.5 pb-2">
            {rows.map((row) => (
              <StepItem key={row.index} row={row} selected={row.index === selected} onSelect={() => onSelect(row.index === selected ? null : row.index)} />
            ))}
          </ol>
        </section>
      )}
      <section aria-label="Run history">
        <GroupTitle count={history.length === 0 ? undefined : Math.min(history.length, 20)}>History</GroupTitle>
        {history.length === 0 ? (
          <p className={sidePanelNote}>No runs in this worktree yet.</p>
        ) : (
          <ul className="space-y-0.5 pt-0.5 pb-2">
            {historyRows(history, Date.now()).map((entry) => (
              <li key={entry.runId} className="flex h-8 items-center gap-2 rounded-[12px] px-2.5 text-[12.5px]">
                <span className={sidePanelSlot}>
                  <StatusIcon status={entry.state === 'running' ? 'running' : entry.state === 'stopped' ? 'skipped' : entry.state} />
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-300" title={entry.flow}>
                  {entry.flow
                    .split('/')
                    .at(-1)
                    ?.replace(/\.ya?ml$/, '') ?? entry.flow}
                </span>
                <span className={sidePanelTrailing}>{entry.duration}</span>
                <span className={`${sidePanelTrailing} w-[64px] text-right`}>{entry.time}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function StepItem({ row, selected, onSelect }: { row: StepRow; selected: boolean; onSelect: () => void }) {
  const running = row.status === 'running'
  return (
    <li>
      <button
        type="button"
        disabled={running}
        onClick={onSelect}
        aria-expanded={row.error === null ? undefined : selected}
        className={`flex min-h-8 w-full items-start gap-2 rounded-[12px] px-2.5 py-1.5 text-left transition-colors ${selected ? 'bg-row-selected' : 'enabled:hover:bg-row-hover'}`}
      >
        <span className="w-4 shrink-0 text-right text-[11px] leading-5 text-ink-500 tabular-nums">{row.index}</span>
        <span className="grid h-5 w-3.5 shrink-0 place-items-center">
          <StatusIcon status={row.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[12.5px] leading-5 ${running ? 'text-ink-400 italic' : row.status === 'failed' ? 'text-bad' : 'text-ink-200'} ${selected ? '' : 'truncate'}`}>{row.command ?? 'Running…'}</span>
          {row.error !== null && <span className={`mt-0.5 block font-mono text-[11px] leading-4 whitespace-pre-wrap text-bad/90 select-text ${selected ? '' : 'line-clamp-2'}`}>{row.error}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] leading-5 text-ink-500 tabular-nums">
          {row.screenshot !== null && <ImageIcon />}
          {row.durationMs !== null && `${(row.durationMs / 1000).toFixed(1)} s`}
        </span>
      </button>
    </li>
  )
}

function StatusIcon({ status }: { status: StepRow['status'] }) {
  if (status === 'running')
    return (
      <span className="flex shrink-0 items-center justify-center" aria-label="running">
        <Spinner />
      </span>
    )
  const glyph = {
    passed: 'M4 8.5l2.5 2.5L12 5.5',
    failed: 'M5 5l6 6M11 5l-6 6',
    skipped: 'M4.5 8h7',
  }[status]
  const tone = {
    passed: 'text-ok',
    failed: 'text-bad',
    skipped: 'text-ink-500',
  }[status]
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label={status} className={`shrink-0 ${tone}`}>
      <path d={glyph} />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.4 2.7a.6.6 0 0 0-.9.5Z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
    </svg>
  )
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-label="has a screenshot">
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5" />
    </svg>
  )
}
