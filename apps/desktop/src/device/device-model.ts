import type { BootedSimulator, MaestroEvent, MaestroFlow, MaestroRun, Simulator, SimulatorKind } from '@/api/schema'
import { runPanelLimits, sidebarLimits } from '@/lib/panel-width'

// The Device tab: a worktree's Maestro flows, an iOS simulator's screen and a run's steps as
// `maestro run --json` prints them. The CLI says a step only once it finished; the step in progress
// is derived here, the next index after the last finished one.

export type RunPhase = 'idle' | 'queued' | 'running' | 'passed' | 'failed' | 'stopped'

export interface StepRow {
  index: number
  /** Null on the derived row for the step in progress: the CLI names a step once it finished. */
  command: string | null
  status: 'passed' | 'failed' | 'skipped' | 'running'
  durationMs: number | null
  screenshot: string | null
  error: string | null
}

export interface RunState {
  /** Queued from the request until the CLI's start line: admission and the device check come first. */
  phase: RunPhase
  flow: string | null
  device: string | null
  runId: string | null
  /** Finished steps, in index order. */
  steps: StepRow[]
  durationMs: number | null
  /** Why the run ended without a verdict: the CLI's first error line. */
  error: string | null
  /** Stop was asked for; the stream closing then means stopped, not failed. */
  stopping: boolean
}

export const idleRun: RunState = { phase: 'idle', flow: null, device: null, runId: null, steps: [], durationMs: null, error: null, stopping: false }

export type RunAction = { type: 'request'; flow: string; device: string } | { type: 'event'; event: MaestroEvent } | { type: 'stop' } | { type: 'end'; error: string | null }

export const isActive = (state: RunState) => state.phase === 'queued' || state.phase === 'running'

export function reduceRun(state: RunState, action: RunAction): RunState {
  if (action.type === 'request') return { ...idleRun, phase: 'queued', flow: action.flow, device: action.device }
  if (!isActive(state)) return state
  if (action.type === 'stop') return { ...state, stopping: true }
  if (action.type === 'end') {
    const error = action.error === null || action.error.trim() === '' ? null : action.error.trim()
    if (state.stopping) return { ...state, phase: 'stopped', stopping: false, error: null }
    return { ...state, phase: 'failed', error: error ?? 'The run ended without a result.' }
  }
  const event = action.event
  if (event.type === 'start') return { ...state, phase: 'running', runId: event.runId, flow: event.flow, device: event.device }
  if (event.type === 'run') return { ...state, phase: event.state === 'running' ? 'running' : event.state, durationMs: event.durationMs, stopping: false }
  const row: StepRow = { index: event.index, command: event.command, status: event.status, durationMs: event.durationMs, screenshot: event.screenshot, error: event.error === null || event.error === '' ? null : event.error }
  const steps = [...state.steps.filter((step) => step.index !== row.index), row].sort((a, b) => a.index - b.index)
  return { ...state, phase: 'running', steps }
}

/** The finished steps, plus the one in progress while the run goes on and nothing failed yet. */
export function stepRows(state: RunState): StepRow[] {
  if (state.phase !== 'running' || state.steps.some((step) => step.status === 'failed')) return state.steps
  const next = (state.steps.at(-1)?.index ?? 0) + 1
  return [...state.steps, { index: next, command: null, status: 'running', durationMs: null, screenshot: null, error: null }]
}

/** Maestro is missing: the run says so with this text (commands/maestro.ts). */
export const needsInstall = (error: string | null) => error !== null && /Maestro is not installed/i.test(error)

/**
 * What the phone frame shows: the chosen step's screenshot when it has one, else the live capture,
 * else the latest step that took one.
 */
export function screenSource({ selected, rows, capture }: { selected: number | null; rows: readonly StepRow[]; capture: string | null }): { path: string; step: number | null } | null {
  const chosen = selected === null ? undefined : rows.find((row) => row.index === selected)
  if (chosen?.screenshot != null) return { path: chosen.screenshot, step: chosen.index }
  if (capture !== null) return { path: capture, step: null }
  const latest = [...rows].reverse().find((row) => row.screenshot !== null)
  return latest?.screenshot == null ? null : { path: latest.screenshot, step: latest.index }
}

export function durationLabel(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} m ${String(seconds % 60).padStart(2, '0')} s`
}

export function timeLabel(iso: string, now: number): string {
  const at = Date.parse(iso)
  const ago = now - at
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} h ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export interface HistoryRow {
  runId: string
  flow: string
  state: MaestroRun['state']
  duration: string
  time: string
}

const historySize = 20

/** The worktree's runs as the CLI lists them, newest first, the latest twenty. */
export function historyRows(runs: readonly MaestroRun[], now: number): HistoryRow[] {
  return runs.slice(0, historySize).map((run) => ({ runId: run.runId, flow: run.flow, state: run.state, duration: durationLabel(run.durationMs), time: timeLabel(run.startedAt, now) }))
}

export interface FlowGroup {
  folder: string
  flows: MaestroFlow[]
}

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** Flows by folder, folders in path order; a search keeps the flows whose name or path contains it. */
export function groupFlows(flows: readonly MaestroFlow[], query: string): FlowGroup[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, MaestroFlow[]>()
  for (const flow of [...flows].sort((a, b) => a.path.localeCompare(b.path))) {
    if (needle !== '' && !flow.name.toLowerCase().includes(needle) && !flow.path.toLowerCase().includes(needle)) continue
    const folder = folderOf(flow.path)
    groups.set(folder, [...(groups.get(folder) ?? []), flow])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => ({ folder, flows: list }))
}

/** The name `maestro new` accepts, without its .yaml; null when it would refuse it. */
export function newFlowName(input: string): string | null {
  const name = input.trim().replace(/\.ya?ml$/, '')
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? name : null
}

/** A simulator the picker lists, tagged with the list it came from (`native sim list phone|tv`). */
export type DeviceChoice = Simulator & { kind: SimulatorKind }

/** A device in the sidebar: booted, or shut down by megabrain when idle and so still open. */
export interface OpenDevice {
  udid: string
  name: string
  runtime: string | null
  kind: SimulatorKind
  state: 'Booted' | 'Asleep'
  /** The worktree that claimed it; null when no worktree has, or megabrain put it to sleep. */
  worktree: string | null
  /** The project the CLI says owns it, by path or name; absent or null when it does not say. */
  project?: string | null
}

const byKindThenName = (a: { kind: SimulatorKind; name: string }, b: { kind: SimulatorKind; name: string }) => Number(a.kind === 'tv') - Number(b.kind === 'tv') || a.name.localeCompare(b.name)

/** The CLI reports CoreSimulator runtime identifiers; show the readable platform and version. */
export function runtimeLabel(runtime: string | null): string | null {
  if (runtime === null) return null
  const identifier = runtime.match(/(?:^|\.)SimRuntime\.(iOS|tvOS)-(\d+(?:-\d+)*)$/)
  const [, platform, version] = identifier ?? []
  if (platform !== undefined && version !== undefined) return `${platform} ${version.replaceAll('-', '.')}`
  return runtime
}

/** The sidebar's devices: the booted ones and the ones megabrain put to sleep, phones first, then by name. */
export function openDevices(booted: readonly (BootedSimulator & { project?: string | null })[], available: readonly DeviceChoice[], asleep: readonly string[]): OpenDevice[] {
  const open: OpenDevice[] = booted.filter((row) => row.state === 'Booted').map((row) => ({ udid: row.udid, name: row.name, runtime: row.runtime, kind: row.kind, state: 'Booted', worktree: row.worktree ?? null, project: row.project ?? null }))
  for (const device of available) {
    if (asleep.includes(device.udid) && !open.some((entry) => entry.udid === device.udid)) open.push({ udid: device.udid, name: device.name, runtime: null, kind: device.kind, state: 'Asleep', worktree: null, project: null })
  }
  return open.sort(byKindThenName)
}

/** The selected device: the chosen one while it is open, else the first open, else none. */
export function selectDevice(open: readonly { udid: string }[], chosen: string | null): string | null {
  if (chosen !== null && open.some((device) => device.udid === chosen)) return chosen
  return open[0]?.udid ?? null
}

/** The sidebar's groups, in the order they show: a tablet is a phone-list simulator named iPad. */
export type DeviceGroup = 'phone' | 'tablet' | 'tv' | 'web'

export const deviceGroups: readonly DeviceGroup[] = ['phone', 'tablet', 'tv', 'web']

export const groupTitles: Record<DeviceGroup, string> = { phone: 'Phones', tablet: 'Tablets', tv: 'TVs', web: 'Web' }

export function groupOf(device: { kind: SimulatorKind | 'web'; name: string }): DeviceGroup {
  if (device.kind === 'tv' || device.kind === 'web') return device.kind
  return /\bipad\b/i.test(device.name) ? 'tablet' : 'phone'
}

/** Devices by group, in group order, keeping each group's own order; a group with none is left out. */
export function groupDevices<T extends { kind: SimulatorKind | 'web'; name: string }>(devices: readonly T[]): { group: DeviceGroup; devices: T[] }[] {
  return deviceGroups.map((group) => ({ group, devices: devices.filter((device) => groupOf(device) === group) })).filter((entry) => entry.devices.length > 0)
}

/** What the + picker offers: every available device not already open, phones first, then by name. */
export function pickerChoices(available: readonly DeviceChoice[], open: readonly OpenDevice[]): DeviceChoice[] {
  return available.filter((device) => !open.some((entry) => entry.udid === device.udid)).sort(byKindThenName)
}

/** A device shut down leaves the sidebar; the selection stays unless it was that device. */
export function afterShutdown(open: readonly OpenDevice[], chosen: string | null, udid: string): { open: OpenDevice[]; selected: string | null } {
  const left = open.filter((device) => device.udid !== udid)
  return { open: left, selected: selectDevice(left, chosen === udid ? null : chosen) }
}

/** A device restarted stays where it is, booted, and the selection does not move. */
export function afterRestart(open: readonly OpenDevice[], chosen: string | null, udid: string): { open: OpenDevice[]; selected: string | null } {
  const next = open.map((device): OpenDevice => (device.udid === udid ? { ...device, state: 'Booted' } : device))
  return { open: next, selected: selectDevice(next, chosen) }
}

/** A project as the sidebar's list has it: its name, its main checkout and its worktrees' paths and branches. */
export interface ProjectRef {
  name: string
  path: string
  worktrees: readonly { path: string; branch: string | null }[]
}

/** A device another project owns, or none does, with the branch it is on when its worktree is known. */
export interface ElsewhereDevice {
  device: OpenDevice
  branch: string | null
}

/** The devices of one other project, or the ones no project owns (`assigned` false, titled Not assigned). */
export interface ElsewhereGroup {
  key: string
  title: string
  assigned: boolean
  devices: ElsewhereDevice[]
}

export interface DeviceSections {
  /** The devices this project owns, from any of its worktrees. */
  mine: OpenDevice[]
  elsewhere: ElsewhereGroup[]
  elsewhereCount: number
}

const trimPath = (path: string) => path.replace(/\/+$/, '')
const samePath = (a: string, b: string) => trimPath(a) === trimPath(b)
const folderName = (path: string) => trimPath(path).split('/').at(-1) ?? path
const hasWorktree = (project: ProjectRef, path: string) => samePath(project.path, path) || project.worktrees.some((worktree) => samePath(worktree.path, path))

/**
 * Who owns a device: the project the CLI reports, matched by path or name, else the one whose worktree
 * claimed it; a project the list does not know keys by its own path. Null when nothing owns it.
 */
function ownerOf(device: OpenDevice, projects: readonly ProjectRef[]): { key: string; title: string } | null {
  const reported = device.project ?? null
  if (reported !== null) {
    const known = projects.find((project) => samePath(project.path, reported) || project.name === reported)
    return known === undefined ? { key: trimPath(reported), title: folderName(reported) } : { key: trimPath(known.path), title: known.name }
  }
  if (device.worktree === null) return null
  const claimed = device.worktree
  const known = projects.find((project) => hasWorktree(project, claimed))
  return known === undefined ? { key: trimPath(claimed), title: folderName(claimed) } : { key: trimPath(known.path), title: known.name }
}

const notAssigned = 'Not assigned'

/** The sidebar's split: the devices this worktree's project owns, and the rest by project, Not assigned last. */
export function deviceSections(open: readonly OpenDevice[], root: string, projects: readonly ProjectRef[]): DeviceSections {
  const current = projects.find((project) => hasWorktree(project, root))
  const here = trimPath(current?.path ?? root)
  const mine: OpenDevice[] = []
  const groups = new Map<string, ElsewhereGroup>()
  for (const device of open) {
    const owner = ownerOf(device, projects)
    if (owner?.key === here) {
      mine.push(device)
      continue
    }
    const key = owner?.key ?? ''
    const group = groups.get(key) ?? { key, title: owner?.title ?? notAssigned, assigned: owner !== null, devices: [] }
    const worktree = device.worktree
    const branch = worktree === null ? null : (projects.flatMap((project) => project.worktrees).find((entry) => samePath(entry.path, worktree))?.branch ?? null)
    group.devices.push({ device, branch })
    groups.set(key, group)
  }
  const elsewhere = [...groups.values()].sort((a, b) => Number(!a.assigned) - Number(!b.assigned) || a.title.localeCompare(b.title))
  return { mine, elsewhere, elsewhereCount: elsewhere.reduce((sum, group) => sum + group.devices.length, 0) }
}

/** The indicator under the list; null when every open device is this project's. */
export function elsewhereLabel(count: number): string | null {
  return count === 0 ? null : `${count} elsewhere`
}

/** A name being typed over a device's. */
export type RenameDraft = { udid: string; text: string } | null

/** simctl's limit on a device name. */
const nameLimit = 255

/** What Enter saves: the trimmed name, or nothing when it is empty, unchanged, too long or for another device. */
export function renameCommit(draft: RenameDraft, device: OpenDevice): { udid: string; name: string } | null {
  if (draft === null || draft.udid !== device.udid) return null
  const name = draft.text.trim()
  if (name === '' || name === device.name || name.length > nameLimit) return null
  return { udid: device.udid, name }
}

/** A renamed device shows its new name at once, in its place by name. */
export function afterRename(open: readonly OpenDevice[], udid: string, name: string): OpenDevice[] {
  return open.map((device) => (device.udid === udid ? { ...device, name } : device)).sort(byKindThenName)
}

/** Where the Device tab remembers whether each side panel is open (wiki-shell-model's readPanelOpen). */
export const devicePanels = { devices: 'megabrain.device.devices.open', flows: 'megabrain.device.flows.open' } as const

export type DevicePanel = keyof typeof devicePanels

/** Where a panel is: beside the screen, over it, or folded to its toggle. */
export type PanelPlace = 'side' | 'overlay' | 'hidden'

/** The room each takes beside the others: the panels at their width, the screen at the least it needs. */
export const deviceWidths = { devices: sidebarLimits.min, flows: runPanelLimits.min, screen: 360 } as const

/**
 * Where each panel goes in a Device tab `width` wide: the devices always at the left, the flows at the
 * right, never merged. A panel the person keeps open sits beside the screen while there is room; the
 * flows fold first, then the devices. One folded panel the person reopens (`peek`) overlays the screen.
 */
export function panelPlaces(width: number, open: Record<DevicePanel, boolean>, peek: DevicePanel | null): Record<DevicePanel, PanelPlace> {
  const devicesSide = open.devices && width >= deviceWidths.devices + deviceWidths.screen
  const flowsSide = open.flows && width >= deviceWidths.flows + deviceWidths.screen + (devicesSide ? deviceWidths.devices : 0)
  const place = (side: boolean, panel: DevicePanel): PanelPlace => (side ? 'side' : peek === panel ? 'overlay' : 'hidden')
  return { devices: place(devicesSide, 'devices'), flows: place(flowsSide, 'flows') }
}

/** What the screen says about a simulator megabrain shut down when idle; null for any other. */
export function sleepNote(device: Simulator | null, asleep: readonly string[]): string | null {
  return device !== null && device.state !== 'Booted' && asleep.includes(device.udid) ? 'Asleep: boots when you run a flow' : null
}

/** Run on a simulator that is not booted boots it first; a failed boot never starts the run. */
export async function bootThenRun(needsBoot: boolean, boot: () => Promise<void>, run: () => void): Promise<void> {
  if (needsBoot) await boot()
  run()
}
