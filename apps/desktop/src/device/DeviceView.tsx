import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { BootedSimulator, MaestroFlow, MaestroRun } from '@/api/schema'
import { afterRename, afterRestart, afterShutdown, bootThenRun, deviceLayout, devicePanels, deviceSections, panelsShown, isActive, openDevices, pickerChoices, runtimeLabel, screenSource, selectDevice, stepRows, type DeviceChoice, type DeviceLayout, type OpenDevice, type ProjectRef } from '@/device/device-model'
import { PanelIcon } from '@/advanced/WikiShell'
import { readPanelOpen, writePanelOpen } from '@/advanced/wiki-shell-model'
import { SlidePanel } from '@/components/SlidePanel'
import { DevicesSidebar, type DeviceBusy } from '@/device/DevicesSidebar'
import { FlowsRunPanel, type Load } from '@/device/FlowsRunPanel'
import { startRun, stopRun, useDeviceRun } from '@/device/run-store'
import { changesPolicy, projectsPolicy, screenPolicy } from '@/lib/poll-model'
import { runPanelLimits, sidebarLimits } from '@/lib/panel-width'
import { sidePanelButton } from '@/lib/side-panel'
import { native } from '@/lib/surface'
import { usePoll } from '@/lib/usePoll'

const toAsset = native ? convertFileSrc : null

const browserStorage = () => localStorage

/** A side panel's open state, remembered per viewer as the Knowledge panel's is. */
function usePanelOpen(key: string) {
  const [open, setOpen] = useState(() => readPanelOpen(browserStorage, key))
  return [open, (next: boolean) => setOpen(writePanelOpen(browserStorage, key, next))] as const
}

// The Device tab is content, so its panels are the content's opaque black, a hairline toward the screen.
const panelEdge = { left: 'bg-ink-950 border-r border-white/[0.06]', right: 'bg-ink-950 border-l border-white/[0.06]' } as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A worktree's Device tab: the open simulators at the left (DevicesSidebar: boot, restart, shut down),
 * the selected one's screen framed like a device in the middle, and its Maestro flows and the run at
 * the right (FlowsRunPanel), the steps filling in as the CLI prints them. The
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

  const [devicesOpen, setDevicesOpen] = usePanelOpen(devicePanels.devices)
  const [flowsOpen, setFlowsOpen] = usePanelOpen(devicePanels.flows)
  const shown = panelsShown(layout, { devices: devicesOpen, flows: flowsOpen })
  const canHide = layout !== 'stack'

  const run = useDeviceRun(root)
  const active = isActive(run)
  const [flows, setFlows] = useState<Load<MaestroFlow[]>>({ kind: 'loading' })
  const [runs, setRuns] = useState<MaestroRun[]>([])
  const [booted, setBooted] = useState<Load<BootedSimulator[]>>({ kind: 'loading' })
  const [available, setAvailable] = useState<DeviceChoice[] | null>(null)
  const [busy, setBusy] = useState<Record<string, DeviceBusy>>({})
  const [booting, setBooting] = useState<DeviceChoice[]>([])
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [chosenFlow, setChosenFlow] = useState<string | null>(null)
  const [chosenDevice, setChosenDevice] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ udid: string; path: string; at: number } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [asleep, setAsleep] = useState<string[]>([])
  const [waking, setWaking] = useState(false)
  // Names and branches for the devices other worktrees own; read once, as the list barely changes.
  const [projects, setProjects] = useState<ProjectRef[]>([])
  useEffect(() => {
    let current = true
    api.projects('megabrain').then(
      (listed) => current && setProjects(listed),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])

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
      const [listed, phones, tvs] = await Promise.all([api.simListBooted().catch((error: unknown) => ({ error })), api.simulators('phone').catch(() => null), api.simulators('tv').catch(() => null)])
      if (!current()) return
      setBooted('error' in listed ? { kind: 'error', error: listed.error } : { kind: 'ready', value: listed })
      if (phones !== null || tvs !== null) setAvailable([...(phones ?? []).map((device) => ({ ...device, kind: 'phone' as const })), ...(tvs ?? []).map((device) => ({ ...device, kind: 'tv' as const }))])
      // The tab showing is what keeps a simulator megabrain booted awake; this also lists the ones it put to sleep.
      const sleeping = await api.simulatorsAsleep().catch(() => null)
      if (current() && sleeping !== null) setAsleep(sleeping)
    },
    [],
  )

  const all = openDevices(booted.kind === 'ready' ? booted.value : [], available ?? [], asleep)
  const sections = deviceSections(all, root, projects)
  // A name being saved shows at once.
  const [renaming, setRenaming] = useState<Record<string, string>>({})
  const open = Object.entries(renaming).reduce<OpenDevice[]>((list, [target, name]) => afterRename(list, target, name), sections.mine)
  const udid = active && run.device !== null ? run.device : selectDevice(open, chosenDevice)
  const device = open.find((entry) => entry.udid === udid) ?? null
  const isBooted = device?.state === 'Booted' && busy[device.udid] === undefined
  const markBusy = (target: string, state: DeviceBusy | null) =>
    setBusy((current) => {
      const { [target]: _dropped, ...rest } = current
      return state === null ? rest : { ...rest, [target]: state }
    })

  const bootChoice = (choice: DeviceChoice) => {
    setLifecycleError(null)
    setBooting((current) => [...current, choice])
    setChosenDevice(choice.udid)
    api
      .bootSimulator(choice.udid, choice.kind, root)
      .then(refreshDevices, (error: unknown) => setLifecycleError(message(error)))
      .finally(() => setBooting((current) => current.filter((entry) => entry.udid !== choice.udid)))
  }
  const restart = (target: OpenDevice) => {
    setLifecycleError(null)
    markBusy(target.udid, 'restarting')
    setCapture((current) => (current?.udid === target.udid ? null : current))
    api
      .simRestart(target.udid)
      .then(() => {
        setChosenDevice((chosen) => afterRestart(open, chosen, target.udid).selected)
        refreshDevices()
      }, (error: unknown) => setLifecycleError(message(error)))
      .finally(() => markBusy(target.udid, null))
  }
  // The confirmation shows a refusal itself, so this one throws it on.
  const shutdown = async (target: OpenDevice) => {
    setLifecycleError(null)
    markBusy(target.udid, 'shutting-down')
    try {
      if (active && run.device === target.udid) await stopRun(root)
      await api.simShutdown(target.udid)
      setChosenDevice((chosen) => afterShutdown(open, chosen, target.udid).selected)
      setBooted((current) => (current.kind === 'ready' ? { kind: 'ready', value: current.value.filter((row) => row.udid !== target.udid) } : current))
      setCapture((current) => (current?.udid === target.udid ? null : current))
      refreshDevices()
    } finally {
      markBusy(target.udid, null)
    }
  }

  // Claiming shows at once; the next read confirms it, or a refusal says why and the read puts it back.
  const claim = async (target: OpenDevice) => {
    setLifecycleError(null)
    setBooted((current) => (current.kind === 'ready' ? { kind: 'ready', value: current.value.map((row) => (row.udid === target.udid ? { ...row, worktree: root } : row)) } : current))
    try {
      await api.simClaim(target.udid, root)
    } finally {
      refreshDevices()
    }
  }
  const rename = (target: OpenDevice, name: string) => {
    setLifecycleError(null)
    setRenaming((current) => ({ ...current, [target.udid]: name }))
    api
      .simRename(target.udid, name)
      .then(() => {
        setBooted((current) => (current.kind === 'ready' ? { kind: 'ready', value: current.value.map((row) => (row.udid === target.udid ? { ...row, name } : row)) } : current))
        setAvailable((current) => current?.map((entry) => (entry.udid === target.udid ? { ...entry, name } : entry)) ?? null)
        refreshDevices()
      }, (error: unknown) => setLifecycleError(message(error)))
      .finally(() =>
        setRenaming((current) => {
          const { [target.udid]: _done, ...rest } = current
          return rest
        }),
      )
  }
  const select = (next: string) => {
    setChosenDevice(next)
    setSelectedStep(null)
    const target = open.find((entry) => entry.udid === next)
    if (target !== undefined && target.worktree === null && target.state === 'Booted') claim(target).catch((error: unknown) => setLifecycleError(message(error)))
  }

  const flowList = flows.kind === 'ready' ? flows.value : []
  const flow = active && run.flow !== null ? run.flow : (flowList.find((entry) => entry.path === chosenFlow)?.path ?? flowList[0]?.path ?? null)

  // A fresh capture every 2 s while a run goes on; otherwise one, when the device has none yet.
  const hasCapture = capture !== null && capture.udid === udid
  usePoll(
    screenPolicy,
    async (current) => {
      if (udid === null || !isBooted || (!active && hasCapture)) return
      try {
        const path = await api.simulatorScreenshot(udid)
        if (!current()) return
        setCapture({ udid, path, at: Date.now() })
        setCaptureError(null)
      } catch (error) {
        if (current()) setCaptureError(message(error))
      }
    },
    [udid, isBooted, active, hasCapture],
  )

  const rows = stepRows(run)
  const liveCapture = hasCapture && capture !== null ? (toAsset === null ? capture.path : `${toAsset(capture.path)}?v=${capture.at}`) : null
  const screen = screenSource({ selected: selectedStep, rows, capture: liveCapture })
  const src = screen === null ? null : screen.step === null || toAsset === null ? screen.path : toAsset(screen.path)

  const play = () => {
    if (flow === null || udid === null || waking) return
    setSelectedStep(null)
    // A simulator that went to sleep (or was never booted) boots first, through the same call as the Boot button.
    setWaking(true)
    setCaptureError(null)
    bootThenRun(!isBooted, () => api.bootSimulator(udid, device?.kind, root).then(refreshDevices), () => startRun(root, flow, udid))
      .catch((error: unknown) => setCaptureError(message(error)))
      .finally(() => setWaking(false))
  }

  const devicesPanel = (
    <DevicesSidebar
      open={open}
      available={sections.available}
      others={sections.others}
      othersCount={sections.othersCount}
      booting={booting}
      error={booted.kind === 'error' ? message(booted.error) : lifecycleError}
      loading={booted.kind === 'loading'}
      selected={udid}
      locked={active}
      busy={busy}
      choices={available === null ? null : pickerChoices(available, all)}
      onSelect={select}
      onBoot={bootChoice}
      onRestart={restart}
      onShutdown={shutdown}
      onRename={rename}
      onHide={canHide ? () => setDevicesOpen(false) : undefined}
      onClaim={async (target) => {
        await claim(target)
        select(target.udid)
      }}
    />
  )
  const screenPanel = (
    <ScreenPanel
      device={device}
      src={src}
      step={screen?.step ?? null}
      note={waking ? `Booting ${device?.name ?? 'the simulator'}…` : device !== null && busy[device.udid] !== undefined ? `${device.name} is ${busy[device.udid] === 'restarting' ? 'restarting' : 'shutting down'}…` : isBooted ? captureError : device?.state === 'Asleep' ? 'Asleep: boots when you run a flow' : null}
      tall={layout !== 'stack'}
      showDevices={canHide && !shown.devices ? () => setDevicesOpen(true) : null}
      showFlows={canHide && !shown.flows ? () => setFlowsOpen(true) : null}
    />
  )
  const sidePanel = (
    <FlowsRunPanel
      root={root}
      flows={flows}
      chosen={flow}
      onChoose={setChosenFlow}
      onCreated={(path) => {
        refreshFlows()
        setChosenFlow(path)
        onOpenFile?.(path)
      }}
      run={run}
      rows={rows}
      history={runs}
      canRun={flow !== null && udid !== null && !active && !waking && (device === null || busy[device.udid] === undefined)}
      selected={screen?.step ?? selectedStep}
      onSelect={setSelectedStep}
      onRun={play}
      onStop={() => void stopRun(root)}
      onHide={canHide ? () => setFlowsOpen(false) : undefined}
    />
  )

  return (
    <div ref={box} data-device-layout={layout} className="flex min-h-0 flex-1 overflow-hidden bg-ink-950">
      {layout === 'columns' ? (
        <>
          <SlidePanel open={shown.devices} side="left" width={sidebarLimits.min} className={panelEdge.left} handle={null}>
            {devicesPanel}
          </SlidePanel>
          <div className="flex min-w-0 flex-1 flex-col">{screenPanel}</div>
          <SlidePanel open={shown.flows} side="right" width={runPanelLimits.min} className={panelEdge.right} handle={null}>
            {sidePanel}
          </SlidePanel>
        </>
      ) : layout === 'split' ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col">{screenPanel}</div>
          <SlidePanel open={shown.flows} side="right" width={runPanelLimits.min} className={panelEdge.right} handle={null}>
            {shown.devices && <div className="flex max-h-[35%] min-h-0 flex-col border-b border-white/[0.06]">{devicesPanel}</div>}
            <div className="flex min-h-0 flex-1 flex-col">{sidePanel}</div>
          </SlidePanel>
        </>
      ) : (
        <div className="h-full min-w-0 flex-1 overflow-y-auto">
          <div className="flex flex-col">
            <div className="flex flex-col border-b border-white/[0.06]">{devicesPanel}</div>
            {screenPanel}
            <div className="flex h-[560px] flex-col border-t border-white/[0.06]">{sidePanel}</div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The screen fills the middle: the device centred and scaled to fit, the hidden panels' toggles in its top corners. */
function ScreenPanel({ device, src, step, note, tall, showDevices, showFlows }: { device: OpenDevice | null; src: string | null; step: number | null; note: string | null; tall: boolean; showDevices: (() => void) | null; showFlows: (() => void) | null }) {
  const [aspect, setAspect] = useState(1206 / 2622)
  return (
    <div className={`relative flex min-h-0 flex-col bg-ink-950 ${tall ? 'flex-1' : ''}`}>
      {showDevices !== null && (
        <button type="button" onClick={showDevices} aria-label="Show devices" title="Show devices" className={`${sidePanelButton} absolute top-3 left-3 z-10`}>
          <PanelIcon />
        </button>
      )}
      {showFlows !== null && (
        <button type="button" onClick={showFlows} aria-label="Show flows" title="Show flows" className={`${sidePanelButton} absolute top-3 right-3 z-10`}>
          <PanelIcon />
        </button>
      )}
      {step !== null && <span className="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11.5px] text-ink-300 tabular-nums">Step {step}</span>}
      {/* A size container, so the frame takes the largest box of the screenshot's aspect that fits. */}
      <div style={{ containerType: 'size' }} className={`flex min-h-0 items-center justify-center ${tall ? 'm-12 flex-1' : 'mx-8 my-6 h-[520px]'}`}>
        <div data-device-frame="" title={device === null ? undefined : `${device.name}${runtimeLabel(device.runtime) === null ? '' : ` · ${runtimeLabel(device.runtime)}`}`} style={{ aspectRatio: String(aspect), width: `min(100cqw, calc(100cqh * ${aspect}))` }} className={`border border-white/[0.14] bg-black shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] ${aspect > 1 ? 'rounded-[20px] p-[8px]' : 'rounded-[44px] p-[10px]'}`}>
          <div className={`relative flex h-full w-full items-center justify-center overflow-hidden bg-ink-900 ${aspect > 1 ? 'rounded-[12px]' : 'rounded-[34px]'}`}>
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
              <p className="px-6 text-center text-[12px] leading-5 text-ink-500">{note ?? (device === null ? 'Open a device with + to see its screen' : 'Waiting for the screen…')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
