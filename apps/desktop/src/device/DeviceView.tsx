import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { BootedSimulator, MaestroFlow, MaestroRun } from '@/api/schema'
import { afterRename, afterRestart, afterShutdown, bootThenRun, devicePanels, deviceSections, deviceWidths, groupOf, isActive, panelPlaces, openDevices, pickerChoices, screenSource, selectDevice, stepRows, type DeviceChoice, type DevicePanel, type OpenDevice, type ProjectRef } from '@/device/device-model'
import { readPanelOpen, writePanelOpen } from '@/advanced/wiki-shell-model'
import { SlidePanel } from '@/components/SlidePanel'
import { DeviceScreen } from '@/device/DeviceScreen'
import { inputPaused } from '@/device/screen-model'
import { DevicesSidebar, type DeviceBusy } from '@/device/DevicesSidebar'
import { FlowsRunPanel, type Load } from '@/device/FlowsRunPanel'
import { startRun, stopRun, useDeviceRun } from '@/device/run-store'
import { changesPolicy, deviceCatalogPolicy, devicesPolicy } from '@/lib/poll-model'
import { native } from '@/lib/surface'
import { usePoll } from '@/lib/usePoll'
import { devServerUrl, webDeviceName } from '@/device/web-device-model'
import type { Orientation, ViewportPreset, WebDevice } from '@/api/schema'
import { nextOrientation, webRotation } from '@/device/controls-model'
import { DeviceControls } from '@/device/DeviceControls'
import { useInputSession } from '@/device/input-hooks'

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
 * A worktree's Device tab: the open simulators and browsers at the left (DevicesSidebar: boot,
 * restart, shut down, start a browser), the selected one's controls at its bottom (DeviceControls),
 * its screen framed like the device in the middle, and its Maestro flows and the run at
 * the right (FlowsRunPanel), the steps filling in as the CLI prints them. The panels never merge: when
 * the pane is narrow they fold to their toggles, and one reopened overlays the screen (device-model's
 * panelPlaces). The run itself lives in run-store, so leaving the tab keeps it going. The screen
 * (DeviceScreen) is the chosen step's screenshot, else the simulator's live screen, else the run's
 * latest screenshot.
 */
export function DeviceView({ root, onOpenFile }: { root: string; onOpenFile?: (path: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const [devicesOpen, setDevicesOpen] = usePanelOpen(devicePanels.devices)
  const [flowsOpen, setFlowsOpen] = usePanelOpen(devicePanels.flows)
  // The folded panel the person reopened, over the screen until they hide it again.
  const [peek, setPeek] = useState<DevicePanel | null>(null)
  const places = panelPlaces(width, { devices: devicesOpen, flows: flowsOpen }, peek)
  const setOpen = (panel: DevicePanel, next: boolean) => (panel === 'devices' ? setDevicesOpen(next) : setFlowsOpen(next))
  const showPanel = (panel: DevicePanel) => {
    setOpen(panel, true)
    setPeek(panel)
  }
  // Hiding an overlay only folds it back; hiding a panel beside the screen is remembered.
  const hidePanel = (panel: DevicePanel) => {
    if (places[panel] !== 'overlay') setOpen(panel, false)
    setPeek(null)
  }

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
  const [playError, setPlayError] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [asleep, setAsleep] = useState<string[]>([])
  const [waking, setWaking] = useState(false)
  // Which project each worktree belongs to, to tell this project's devices from the rest; read once, as the list barely changes.
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
  const [web, setWeb] = useState<WebDevice[]>([])
  const [webError, setWebError] = useState<string | null>(null)
  const [defaultUrl, setDefaultUrl] = useState('')
  useEffect(() => {
    let current = true
    api.projectScripts(root).then(
      (scripts) => current && setDefaultUrl(devServerUrl(scripts)),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [root])
  const refreshDevices = usePoll(
    devicesPolicy,
    async (current) => {
      const [listed, browsers] = await Promise.all([api.simListBooted().catch((error: unknown) => ({ error })), api.webDeviceList().catch((error: unknown) => ({ error }))])
      if (!current()) return
      if ('error' in browsers) setWebError(message(browsers.error))
      else {
        setWeb(browsers)
        setWebError(null)
      }
      setBooted('error' in listed ? { kind: 'error', error: listed.error } : { kind: 'ready', value: listed })
      // The tab showing is what keeps a simulator megabrain booted awake; this also lists the ones it put to sleep.
      const sleeping = await api.simulatorsAsleep().catch(() => null)
      if (current() && sleeping !== null) setAsleep(sleeping)
    },
    [],
  )

  // What can be booted barely changes, so it is read on its own, slower schedule.
  usePoll(
    deviceCatalogPolicy,
    async (current) => {
      const [phones, tvs] = await Promise.all([api.simulators('phone').catch(() => null), api.simulators('tv').catch(() => null)])
      if (!current()) return
      if (phones !== null || tvs !== null) setAvailable([...(phones ?? []).map((device) => ({ ...device, kind: 'phone' as const })), ...(tvs ?? []).map((device) => ({ ...device, kind: 'tv' as const }))])
    },
    [],
  )

  const all = openDevices(booted.kind === 'ready' ? booted.value : [], available ?? [], asleep)
  const sections = deviceSections(all, root, projects)
  // A name being saved shows at once.
  const [renaming, setRenaming] = useState<Record<string, string>>({})
  const open = Object.entries(renaming).reduce<OpenDevice[]>((list, [target, name]) => afterRename(list, target, name), sections.mine)
  const udid = active && run.device !== null ? run.device : selectDevice([...open, ...web.map((entry) => ({ udid: entry.id }))], chosenDevice)
  const device = open.find((entry) => entry.udid === udid) ?? null
  const browser = web.find((entry) => entry.id === udid) ?? null
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
      refreshDevices()
    } finally {
      markBusy(target.udid, null)
    }
  }

  // Claiming shows at once; the next read confirms it, or a refusal says why and the read puts it back.
  // A device asleep boots for this worktree instead, which claims it.
  const claim = async (target: OpenDevice) => {
    setLifecycleError(null)
    if (target.state === 'Asleep') {
      markBusy(target.udid, 'booting')
      try {
        await api.bootSimulator(target.udid, target.kind, root)
      } finally {
        markBusy(target.udid, null)
        refreshDevices()
      }
      return
    }
    setBooted((current) => (current.kind === 'ready' ? { kind: 'ready', value: current.value.map((row) => (row.udid === target.udid ? { ...row, worktree: root, project: null } : row)) } : current))
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
  const startWeb = async (url: string, preset: string | null) => {
    setWebError(null)
    const started = await api.webDeviceStart(url, preset, root)
    setWeb((current) => [...current.filter((entry) => entry.id !== started.id), started])
    if (preset !== null) setPresetOf((current) => ({ ...current, [started.id]: preset }))
    setChosenDevice(started.id)
    refreshDevices()
  }
  // The confirmation shows a refusal itself, so this one throws it on.
  const stopWeb = async (target: WebDevice) => {
    setWebError(null)
    if (active && run.device === target.id) await stopRun(root)
    await api.webDeviceStop(target.id)
    setWeb((current) => current.filter((entry) => entry.id !== target.id))
    refreshDevices()
  }
  const select = (next: string) => {
    setChosenDevice(next)
    setSelectedStep(null)
  }

  const flowList = flows.kind === 'ready' ? flows.value : []
  const flow = active && run.flow !== null ? run.flow : (flowList.find((entry) => entry.path === chosenFlow)?.path ?? flowList[0]?.path ?? null)

  const rows = stepRows(run)
  const screen = screenSource({ selected: selectedStep, rows, capture: null })
  const still = screen === null ? null : { src: toAsset === null ? screen.path : toAsset(screen.path), step: screen.step }
  const pinned = still !== null && still.step !== null && still.step === selectedStep ? { src: still.src, step: still.step } : null

  const play = () => {
    if (flow === null || udid === null || waking) return
    setSelectedStep(null)
    // A simulator that went to sleep (or was never booted) boots first, through the same call as the Boot button; a browser is up while listed.
    setWaking(true)
    setPlayError(null)
    bootThenRun(browser === null && !isBooted, () => api.bootSimulator(udid, device?.kind, root).then(refreshDevices), () => startRun(root, flow, udid))
      .catch((error: unknown) => setPlayError(message(error)))
      .finally(() => setWaking(false))
  }

  const paused = inputPaused(run, udid)
  // A Maestro run drives the device itself, so the input session waits for it to end.
  const session = useInputSession(device?.udid ?? null, isBooted && !paused)
  const keyboard = useRef<(() => void) | null>(null)
  const [orientations, setOrientations] = useState<Record<string, Orientation>>({})
  const [presetOf, setPresetOf] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<ViewportPreset[] | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  // One control at a time, in the order the person pressed them.
  const controlQueue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => setControlError(null), [udid])
  const browserShown = browser !== null
  useEffect(() => {
    if (!browserShown || presets !== null) return
    api.webDevicePresets().then(setPresets, () => setPresets([]))
  }, [browserShown, presets])
  const act = (work: () => Promise<unknown>) => {
    controlQueue.current = controlQueue.current.then(work).then(
      () => setControlError(null),
      (error: unknown) => setControlError(message(error)),
    )
  }
  const resized = (next: WebDevice) => setWeb((current) => current.map((entry) => (entry.id === next.id ? next : entry)))
  const pressBrowser = (target: WebDevice, control: string) => {
    if (control === 'rotate') {
      const rotation = webRotation(presetOf[target.id] ?? null, target)
      if (rotation === null) return setControlError('Choose a viewport preset to rotate it.')
      return act(() => api.webDeviceViewport(target.id, rotation.preset, rotation.landscape).then(resized))
    }
    if (control === 'back' || control === 'forward' || control === 'reload') act(() => api.webDeviceInput(target.id, { type: control }).then(refreshDevices))
  }
  const pressSimulator = (target: OpenDevice, control: string) => {
    if (control === 'keyboard') return keyboard.current?.()
    if (control === 'screenshot') return act(() => api.simulatorScreenshot(target.udid).then((path) => api.revealPath(path)))
    if (control === 'rotate') {
      const next = nextOrientation(orientations[target.udid])
      return act(() => api.inputRotate(target.udid, next).then(() => setOrientations((current) => ({ ...current, [target.udid]: next }))))
    }
    act(() => api.inputButton(target.udid, control))
  }
  const controls =
    browser !== null ? (
      <DeviceControls
        group="web"
        name={webDeviceName(browser)}
        disabled={paused}
        error={controlError}
        onPress={(control) => pressBrowser(browser, control)}
        address={{
          url: browser.url,
          onNavigate: (url) => act(() => api.webDeviceInput(browser.id, { type: 'navigate', url }).then(refreshDevices)),
          presets,
          preset: presetOf[browser.id] ?? null,
          onPreset: (slug) => {
            setPresetOf((current) => ({ ...current, [browser.id]: slug }))
            act(() => api.webDeviceViewport(browser.id, slug, false).then(resized))
          },
        }}
      />
    ) : device !== null && isBooted ? (
      <DeviceControls group={groupOf(device)} name={device.name} disabled={paused || session.view.kind !== 'ready'} error={controlError} onPress={(control) => pressSimulator(device, control)} address={null} />
    ) : null

  const devicesPanel = (
    <DevicesSidebar
      open={open}
      elsewhere={sections.elsewhere}
      elsewhereCount={sections.elsewhereCount}
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
      onHide={() => hidePanel('devices')}
      controls={controls}
      web={{ devices: web, error: webError, defaultUrl, onStart: startWeb, onStop: stopWeb }}
      onClaim={async (target) => {
        await claim(target)
        select(target.udid)
      }}
    />
  )
  const screenPanel = (
    <DeviceScreen
      device={device}
      browser={browser}
      booted={isBooted}
      paused={paused}
      session={session}
      keyboard={keyboard}
      pinned={pinned}
      still={still}
      note={browser !== null ? playError : waking ? `Booting ${device?.name ?? 'the simulator'}…` : device !== null && busy[device.udid] !== undefined ? `${device.name} is ${busy[device.udid] === 'restarting' ? 'restarting' : 'shutting down'}…` : isBooted ? playError : device?.state === 'Asleep' ? 'Asleep: boots when you run a flow' : null}
      showDevices={places.devices === 'hidden' ? () => showPanel('devices') : null}
      showFlows={places.flows === 'hidden' ? () => showPanel('flows') : null}
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
      onHide={() => hidePanel('flows')}
    />
  )

  return (
    <div ref={box} className="relative flex min-h-0 flex-1 overflow-hidden bg-ink-950">
      <SlidePanel open={places.devices === 'side'} side="left" width={deviceWidths.devices} className={panelEdge.left} handle={null}>
        {devicesPanel}
      </SlidePanel>
      <div className="flex min-w-0 flex-1 flex-col">{screenPanel}</div>
      <SlidePanel open={places.flows === 'side'} side="right" width={deviceWidths.flows} className={panelEdge.right} handle={null}>
        {sidePanel}
      </SlidePanel>
      {places.devices === 'overlay' && (
        <aside style={{ width: deviceWidths.devices }} className={`${panelEdge.left} ${panelOverlay} left-0`}>
          {devicesPanel}
        </aside>
      )}
      {places.flows === 'overlay' && (
        <aside style={{ width: deviceWidths.flows }} className={`${panelEdge.right} ${panelOverlay} right-0`}>
          {sidePanel}
        </aside>
      )}
    </div>
  )
}

// A folded panel reopened in a narrow pane: over the screen at its own edge, casting a shadow onto it.
const panelOverlay = 'absolute inset-y-0 z-20 flex max-w-full flex-col shadow-[0_0_48px_-12px_rgba(0,0,0,0.9)]'
