import { convertFileSrc } from '@tauri-apps/api/core'
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { MaestroFlow, MaestroRun, Simulator } from '@/api/schema'
import { Spinner } from '@/components/ui'
import { defaultDevice, deviceLayout, groupFlows, historyRows, isActive, needsInstall, newFlowName, screenSource, sortDevices, stepRows, type DeviceLayout, type RunState, type StepRow } from '@/device/device-model'
import { startRun, stopRun, useDeviceRun } from '@/device/run-store'
import { moduleRetryArgs } from '@/onboarding/model'
import { changesPolicy, projectsPolicy, screenPolicy } from '@/lib/poll-model'
import { native } from '@/lib/surface'
import { usePoll } from '@/lib/usePoll'

const toAsset = native ? convertFileSrc : null
const docsUrl = 'https://docs.maestro.dev'

type Load<T> = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; value: T }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A worktree's Device tab: its Maestro flows at the left, an iOS simulator's screen framed like a
 * phone in the middle, and the run at the right, its steps filling in as the CLI prints them. The
 * columns stack when the pane is narrow (device-model's deviceLayout). The run itself lives in
 * run-store, so leaving the tab keeps it going. The screen is the chosen step's screenshot, else a
 * capture taken every 2 s while a run goes on (once otherwise), else the run's latest screenshot.
 */
export function DeviceView({ root, onOpenFile }: { root: string; onOpenFile?: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<DeviceLayout>('columns')
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    const measure = () => setLayout(deviceLayout(element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const run = useDeviceRun(root)
  const active = isActive(run)
  const [flows, setFlows] = useState<Load<MaestroFlow[]>>({ kind: 'loading' })
  const [runs, setRuns] = useState<MaestroRun[]>([])
  const [devices, setDevices] = useState<Load<Simulator[]>>({ kind: 'loading' })
  const [chosenFlow, setChosenFlow] = useState<string | null>(null)
  const [chosenDevice, setChosenDevice] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ udid: string; path: string; at: number } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)

  const refreshFlows = usePoll(
    changesPolicy,
    async (current) => {
      const [listed, history] = await Promise.all([api.maestroFlows(root).catch((error: unknown) => ({ error })), api.maestroRuns(root).catch(() => null)])
      if (!current()) return
      setFlows('error' in listed ? { kind: 'error', error: listed.error } : { kind: 'ready', value: listed })
      if (history !== null) setRuns(history)
    },
    // A run that ends lists itself in the history.
    [root, run.phase],
  )
  const refreshDevices = usePoll(
    projectsPolicy,
    async (current) => {
      const listed = await api.simulators().catch((error: unknown) => ({ error }))
      if (!current()) return
      setDevices('error' in listed ? { kind: 'error', error: listed.error } : { kind: 'ready', value: sortDevices(listed) })
    },
    [],
  )

  const deviceList = devices.kind === 'ready' ? devices.value : []
  const udid = active && run.device !== null ? run.device : defaultDevice(deviceList, chosenDevice)
  const device = deviceList.find((entry) => entry.udid === udid) ?? null
  const booted = device?.state === 'Booted'
  const flowList = flows.kind === 'ready' ? flows.value : []
  const flow = active && run.flow !== null ? run.flow : (flowList.find((entry) => entry.path === chosenFlow)?.path ?? flowList[0]?.path ?? null)

  // A fresh capture every 2 s while a run goes on; otherwise one, when the device has none yet.
  const hasCapture = capture !== null && capture.udid === udid
  usePoll(
    screenPolicy,
    async (current) => {
      if (udid === null || !booted || (!active && hasCapture)) return
      try {
        const path = await api.simulatorScreenshot(udid)
        if (!current()) return
        setCapture({ udid, path, at: Date.now() })
        setCaptureError(null)
      } catch (error) {
        if (current()) setCaptureError(message(error))
      }
    },
    [udid, booted, active, hasCapture],
  )

  const rows = stepRows(run)
  const liveCapture = hasCapture && capture !== null ? (toAsset === null ? capture.path : `${toAsset(capture.path)}?v=${capture.at}`) : null
  const shown = screenSource({ selected: selectedStep, rows, capture: liveCapture })
  const src = shown === null ? null : shown.step === null || toAsset === null ? shown.path : toAsset(shown.path)

  const play = () => {
    if (flow === null || udid === null) return
    setSelectedStep(null)
    startRun(root, flow, udid)
  }

  const flowsPanel = (
    <FlowsPanel
      flows={flows}
      chosen={flow}
      locked={active}
      onChoose={setChosenFlow}
      onCreated={(path) => {
        refreshFlows()
        setChosenFlow(path)
        onOpenFile?.(path)
      }}
      root={root}
    />
  )
  const screenPanel = (
    <ScreenPanel
      devices={devices}
      udid={udid}
      locked={active}
      onChoose={(next) => {
        setChosenDevice(next)
        setSelectedStep(null)
      }}
      onBooted={refreshDevices}
      src={src}
      step={shown?.step ?? null}
      note={booted ? captureError : device === null ? null : `${device.name} is not booted.`}
      tall={layout !== 'stack'}
    />
  )
  const runPanel = (
    <RunPanel run={run} rows={rows} history={runs} flow={flow} canRun={flow !== null && booted && !active} selected={shown?.step ?? selectedStep} onSelect={setSelectedStep} onRun={play} onStop={() => void stopRun(root)} />
  )

  return (
    <div ref={box} data-device-layout={layout} className="min-h-0 flex-1 overflow-hidden bg-ink-950">
      {layout === 'columns' ? (
        <div className="grid h-full grid-cols-[260px_minmax(0,1fr)_340px]">
          <Column className="border-r">{flowsPanel}</Column>
          <Column>{screenPanel}</Column>
          <Column className="border-l">{runPanel}</Column>
        </div>
      ) : layout === 'split' ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_320px]">
          <Column>{screenPanel}</Column>
          <div className="flex min-h-0 flex-col border-l border-white/[0.06]">
            <div className="flex max-h-[40%] min-h-0 flex-col border-b border-white/[0.06]">{flowsPanel}</div>
            <div className="flex min-h-0 flex-1 flex-col">{runPanel}</div>
          </div>
        </div>
      ) : (
        <div className="h-full overflow-y-auto">
          <div className="flex flex-col">
            {screenPanel}
            <div className="border-t border-white/[0.06]">{runPanel}</div>
            <div className="border-t border-white/[0.06]">{flowsPanel}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function Column({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`flex min-h-0 flex-col border-white/[0.06] ${className}`}>{children}</div>
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-4">
      <h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-400 uppercase">{children}</h2>
      {aside}
    </div>
  )
}

const quiet = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-300 hover:bg-white/[0.07] hover:text-ink-100 disabled:cursor-default disabled:text-ink-600 disabled:hover:bg-transparent'
const field = 'h-8 w-full min-w-0 rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 text-[13px] text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent'

function FlowsPanel({ root, flows, chosen, locked, onChoose, onCreated }: { root: string; flows: Load<MaestroFlow[]>; chosen: string | null; locked: boolean; onChoose: (path: string) => void; onCreated: (path: string) => void }) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionTitle
        aside={
          <button type="button" className={quiet} onClick={() => setNaming((current) => !current)} aria-expanded={naming}>
            <PlusIcon /> New flow
          </button>
        }
      >
        Flows
      </SectionTitle>
      {naming && (
        <form onSubmit={create} className="px-4 pb-3">
          <label className="mb-1 block text-[12px] text-ink-400" htmlFor="device-new-flow">
            Creates .maestro/<span className="text-ink-200">{newFlowName(name) ?? 'name'}</span>.yaml and opens it in Code
          </label>
          <div className="flex gap-1.5">
            <input id="device-new-flow" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="checkout" className={field} />
            <button type="submit" disabled={creating} className="h-8 shrink-0 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-ink disabled:bg-ink-700 disabled:text-ink-400">
              Create
            </button>
          </div>
          {createError !== null && <p className="mt-1.5 text-[12px] text-bad">{createError}</p>}
        </form>
      )}
      {list.length > 0 && (
        <div className="px-4 pb-2">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search flows" aria-label="Search flows" className={field} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {flows.kind === 'loading' && <p className="px-4 py-2 text-[13px] text-ink-400">Reading flows…</p>}
        {flows.kind === 'error' && <p className="px-4 py-2 text-[13px] text-bad select-text">{message(flows.error)}</p>}
        {flows.kind === 'ready' && list.length === 0 && (
          <div className="px-4 py-2 text-[13px] leading-5 text-ink-300">
            <p className="font-medium text-ink-100">No flows in this worktree yet</p>
            <p className="mt-1">
              Maestro flows are YAML files in a <span className="font-mono text-[12px] text-ink-200">.maestro</span> or <span className="font-mono text-[12px] text-ink-200">maestro</span> folder at the worktree’s root. Each one lists steps like launching the app, tapping and asserting text.
            </p>
            <button type="button" onClick={() => void api.openUrl(docsUrl)} className="mt-2 text-[13px] font-medium text-accent hover:underline">
              Read the Maestro docs
            </button>
          </div>
        )}
        {flows.kind === 'ready' && list.length > 0 && groups.length === 0 && <p className="px-4 py-2 text-[13px] text-ink-400">No flow matches “{query}”.</p>}
        {groups.map((group) => (
          <div key={group.folder} className="mt-1">
            <p className="truncate px-4 py-1 font-mono text-[11px] text-ink-500">{group.folder}</p>
            {group.flows.map((entry) => {
              const current = entry.path === chosen
              return (
                <button
                  key={entry.path}
                  type="button"
                  disabled={locked && !current}
                  onClick={() => onChoose(entry.path)}
                  aria-current={current || undefined}
                  title={entry.path}
                  className={`flex w-full flex-col items-start px-4 py-1.5 text-left disabled:opacity-50 ${current ? 'bg-white/[0.08]' : 'enabled:hover:bg-white/[0.05]'}`}
                >
                  <span className={`w-full truncate text-[13px] ${current ? 'text-ink-100' : 'text-ink-200'}`}>{entry.name}</span>
                  {entry.appId !== null && <span className="w-full truncate text-[11px] text-ink-500">{entry.appId}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function ScreenPanel({ devices, udid, locked, onChoose, onBooted, src, step, note, tall }: { devices: Load<Simulator[]>; udid: string | null; locked: boolean; onChoose: (udid: string) => void; onBooted: () => void; src: string | null; step: number | null; note: string | null; tall: boolean }) {
  const [booting, setBooting] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [aspect, setAspect] = useState(1206 / 2622)
  const list = devices.kind === 'ready' ? devices.value : []
  const device = list.find((entry) => entry.udid === udid) ?? null

  const boot = () => {
    if (udid === null) return
    setBooting(true)
    setBootError(null)
    api
      .bootSimulator(udid)
      .then(onBooted, (error: unknown) => setBootError(message(error)))
      .finally(() => setBooting(false))
  }

  return (
    <div className={`flex min-h-0 flex-col ${tall ? 'flex-1' : ''}`}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <select aria-label="Simulator" value={udid ?? ''} disabled={locked || list.length === 0} onChange={(event) => onChoose(event.target.value)} className={`${field} max-w-[260px]`}>
          {list.length === 0 && <option value="">{devices.kind === 'loading' ? 'Reading simulators…' : 'No iOS simulator'}</option>}
          {list.map((entry) => (
            <option key={entry.udid} value={entry.udid}>
              {entry.name}
              {entry.state === 'Booted' ? ' · booted' : ''}
            </option>
          ))}
        </select>
        {device !== null && device.state !== 'Booted' && (
          <button type="button" onClick={boot} disabled={booting} className={`${quiet} border border-white/[0.1]`}>
            {booting ? <Spinner /> : <PowerIcon />} {booting ? 'Booting…' : 'Boot'}
          </button>
        )}
        {step !== null && <span className="ml-auto shrink-0 text-[12px] text-ink-400">Step {step}</span>}
      </div>
      {devices.kind === 'error' && <p className="mx-4 mb-2 text-[12px] text-bad select-text">{message(devices.error)}</p>}
      {bootError !== null && <p className="mx-4 mb-2 text-[12px] text-bad select-text">{bootError}</p>}
      <div className={`flex min-h-0 items-center justify-center px-6 pb-6 ${tall ? 'flex-1' : 'h-[520px]'}`}>
        {/* A phone: the screenshot's own aspect, a bezel and rounded corners; the height leads, the width follows. */}
        <div data-device-frame="" style={{ aspectRatio: String(aspect) }} className="h-full max-h-[760px] max-w-full rounded-[44px] border border-white/[0.14] bg-black p-[10px] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]">
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[34px] bg-ink-900">
            {src !== null ? (
              <img
                src={src}
                alt={step === null ? 'The simulator’s screen' : `The screen at step ${step}`}
                onLoad={(event) => {
                  const image = event.currentTarget
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) setAspect(image.naturalWidth / image.naturalHeight)
                }}
                className="h-full w-full object-contain"
              />
            ) : (
              <p className="px-6 text-center text-[12px] leading-5 text-ink-500">{note ?? (device === null ? 'Choose a simulator' : 'Waiting for the screen…')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
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

function RunPanel({ run, rows, history, flow, canRun, selected, onSelect, onRun, onStop }: { run: RunState; rows: StepRow[]; history: MaestroRun[]; flow: string | null; canRun: boolean; selected: number | null; onSelect: (index: number | null) => void; onRun: () => void; onStop: () => void }) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionTitle>Run</SectionTitle>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
        {active ? (
          <button type="button" onClick={onStop} disabled={run.stopping} aria-label="Stop flow" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-bad/40 bg-bad/10 px-3 text-[12px] font-semibold text-bad hover:bg-bad/20 disabled:opacity-50">
            <StopIcon /> {run.stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button type="button" onClick={onRun} disabled={!canRun} aria-label="Run flow" title={flow === null ? 'Choose a flow' : `Run ${flow}`} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-ink hover:bg-[#a3aeff] disabled:bg-ink-700 disabled:text-ink-400">
            <PlayIcon /> Run
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className={`flex items-center gap-1.5 text-[12px] font-medium ${phaseTone[run.phase]}`}>
            {active && <Spinner />}
            {phaseLabel[run.phase]}
          </p>
          {shownFlow !== null && <p className="truncate font-mono text-[11px] text-ink-500" title={shownFlow}>{shownFlow}</p>}
        </div>
      </div>
      {run.error !== null && (
        <div className="mx-4 mb-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] leading-5 text-bad">
          <p className="select-text">{run.error}</p>
          {needsInstall(run.error) && (
            <button type="button" onClick={install} disabled={installing} className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-white/[0.1] px-2.5 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.16] disabled:opacity-60">
              {installing && <Spinner />} {installing ? 'Installing Maestro…' : 'Install Maestro'}
            </button>
          )}
          {installNote !== null && <p className="mt-1.5 text-ink-200">{installNote}</p>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && run.phase === 'idle' && <p className="px-4 text-[13px] text-ink-400">Pick a flow and a booted simulator, then Run. Each step shows here as Maestro finishes it.</p>}
        {rows.length > 0 && (
          <ol aria-label="Steps" className="pb-2">
            {rows.map((row) => (
              <StepItem key={row.index} row={row} selected={row.index === selected} onSelect={() => onSelect(row.index === selected ? null : row.index)} />
            ))}
          </ol>
        )}
        <SectionTitle>History</SectionTitle>
        {history.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-ink-400">No runs in this worktree yet.</p>
        ) : (
          <ul aria-label="Run history" className="pb-4">
            {historyRows(history, Date.now()).map((entry) => (
              <li key={entry.runId} className="flex items-center gap-2 px-4 py-1.5 text-[12px]">
                <StatusIcon status={entry.state === 'running' ? 'running' : entry.state === 'stopped' ? 'skipped' : entry.state} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-200" title={entry.flow}>
                  {entry.flow}
                </span>
                <span className="shrink-0 text-ink-400 tabular-nums">{entry.duration}</span>
                <span className="w-[72px] shrink-0 text-right text-ink-500">{entry.time}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
        className={`flex w-full items-start gap-2 px-4 py-1.5 text-left ${selected ? 'bg-white/[0.08]' : 'enabled:hover:bg-white/[0.05]'}`}
      >
        <span className="w-5 shrink-0 pt-px text-right text-[11px] text-ink-500 tabular-nums">{row.index}</span>
        <StatusIcon status={row.status} />
        <span className="min-w-0 flex-1">
          <span className={`block text-[12.5px] leading-5 ${running ? 'text-ink-400 italic' : row.status === 'failed' ? 'text-bad' : 'text-ink-200'} ${selected ? '' : 'truncate'}`}>{row.command ?? 'Running…'}</span>
          {row.error !== null && <span className={`mt-0.5 block font-mono text-[11px] leading-4 whitespace-pre-wrap text-bad/90 select-text ${selected ? '' : 'line-clamp-2'}`}>{row.error}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-px text-[11px] text-ink-500 tabular-nums">
          {row.screenshot !== null && <ImageIcon />}
          {row.durationMs !== null && `${(row.durationMs / 1000).toFixed(1)} s`}
        </span>
      </button>
    </li>
  )
}

function StatusIcon({ status }: { status: StepRow['status'] }) {
  if (status === 'running') return <span className="flex size-5 shrink-0 items-center justify-center" aria-label="running"><Spinner /></span>
  const glyph = { passed: 'M4 8.5l2.5 2.5L12 5.5', failed: 'M5 5l6 6M11 5l-6 6', skipped: 'M4.5 8h7' }[status]
  const tone = { passed: 'text-ok', failed: 'text-bad', skipped: 'text-ink-500' }[status]
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label={status} className={`shrink-0 ${tone}`}>
      <path d={glyph} />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.4 2.7a.6.6 0 0 0-.9.5Z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}

function PowerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 2.5v5M5 4.2a5 5 0 1 0 6 0" />
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

