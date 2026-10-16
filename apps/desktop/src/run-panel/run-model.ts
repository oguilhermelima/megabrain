import type { ProjectScripts } from '@/api/schema'
import type { PortConflict } from '@/run-panel/port-conflict'

export type RunAction = 'run' | 'build' | 'install'

/** The order the menu lists them in. */
export const runActions: RunAction[] = ['run', 'build', 'install']

export const runActionLabel: Record<RunAction, string> = { run: 'Run', build: 'Build', install: 'Install' }

/** The command an action runs in this project; null when it has none and needs setting up. */
export function commandFor(scripts: ProjectScripts | null, action: RunAction): string | null {
  const command = scripts?.scripts[action]?.command.trim() ?? ''
  return command === '' ? null : command
}

export function needsSetup(scripts: ProjectScripts | null, action: RunAction): boolean {
  return commandFor(scripts, action) === null
}

/** The split button's main half runs the action used last in the worktree, Run before any. */
export function primaryAction(last: RunAction | null | undefined): RunAction {
  return last ?? 'run'
}

/**
 * The argv for the embedded terminal: it attaches to the tmux session `megabrain repo run` started,
 * so the terminal ends when the script does. TMUX is unset so it also attaches from inside tmux.
 */
export function attachCommand(session: string): string[] {
  return ['/usr/bin/env', '-u', 'TMUX', 'tmux', 'attach-session', '-t', session]
}

export type RunStatus = { kind: 'starting' } | { kind: 'running' } | { kind: 'exited'; code: number | null }

export interface RunTab {
  action: RunAction
  command: string
  /** A new number for every start, so a restarted run gets a fresh terminal and late news from the old one is dropped. */
  generation: number
  terminalId: string | null
  status: RunStatus
  /** The free port the run moved to because its own was taken; null on its own port. */
  movedTo: number | null
  /** Its port was taken when it failed: the choice the tab offers until it runs again. */
  conflict: PortConflict | null
}

export interface WorktreePanel {
  open: boolean
  tabs: RunTab[]
  active: RunAction | null
  last: RunAction | null
}

/** The right-hand run panel of each worktree, by worktree path. */
export type RunPanels = Record<string, WorktreePanel>

const emptyPanel: WorktreePanel = { open: false, tabs: [], active: null, last: null }

let generations = 0

export function panelFor(panels: RunPanels, worktree: string): WorktreePanel {
  return panels[worktree] ?? emptyPanel
}

function withPanel(panels: RunPanels, worktree: string, change: (panel: WorktreePanel) => WorktreePanel): RunPanels {
  return { ...panels, [worktree]: change(panelFor(panels, worktree)) }
}

function withTab(panels: RunPanels, worktree: string, action: RunAction, generation: number, change: (tab: RunTab) => RunTab): RunPanels {
  const panel = panelFor(panels, worktree)
  if (!panel.tabs.some((tab) => tab.action === action && tab.generation === generation)) return panels
  return withPanel(panels, worktree, (current) => ({ ...current, tabs: current.tabs.map((tab) => (tab.action === action && tab.generation === generation ? change(tab) : tab)) }))
}

/** Starts an action: its tab (new, or replacing the last run) becomes active and the panel opens. `movedTo` is the free port it runs on instead of its own. */
export function startRun(panels: RunPanels, worktree: string, action: RunAction, command: string, movedTo: number | null = null): RunPanels {
  const tab: RunTab = { action, command, generation: ++generations, terminalId: null, status: { kind: 'starting' }, movedTo, conflict: null }
  return withPanel(panels, worktree, (panel) => ({
    open: true,
    active: action,
    last: action,
    tabs: panel.tabs.some((item) => item.action === action) ? panel.tabs.map((item) => (item.action === action ? tab : item)) : [...panel.tabs, tab],
  }))
}

export function markStarted(panels: RunPanels, worktree: string, action: RunAction, generation: number, terminalId: string): RunPanels {
  return withTab(panels, worktree, action, generation, (tab) => ({ ...tab, terminalId, status: tab.status.kind === 'exited' ? tab.status : { kind: 'running' } }))
}

export function markExited(panels: RunPanels, worktree: string, action: RunAction, generation: number, code: number | null): RunPanels {
  return withTab(panels, worktree, action, generation, (tab) => ({ ...tab, status: { kind: 'exited', code } }))
}

export function setConflict(panels: RunPanels, worktree: string, action: RunAction, generation: number, conflict: PortConflict | null): RunPanels {
  return withTab(panels, worktree, action, generation, (tab) => ({ ...tab, conflict }))
}

/** A tab's name: the action, and the port when it moved off its own. */
export function runTabTitle(tab: RunTab): string {
  return tab.movedTo === null ? runActionLabel[tab.action] : `${runActionLabel[tab.action]} · port ${tab.movedTo}`
}

export function isRunning(panels: RunPanels, worktree: string, action: RunAction): boolean {
  const tab = panelFor(panels, worktree).tabs.find((item) => item.action === action)
  return tab !== undefined && tab.status.kind !== 'exited'
}

/** How many of the panel's runs are starting or running; hiding the panel stops none of them. */
export function liveRuns(panel: WorktreePanel): number {
  return panel.tabs.filter((tab) => tab.status.kind !== 'exited').length
}

export function selectTab(panels: RunPanels, worktree: string, action: RunAction): RunPanels {
  return withPanel(panels, worktree, (panel) => (panel.tabs.some((tab) => tab.action === action) ? { ...panel, active: action } : panel))
}

/** Removes a tab; the one after it (else before) becomes active, and no tabs left closes the panel. */
export function closeTab(panels: RunPanels, worktree: string, action: RunAction): RunPanels {
  return withPanel(panels, worktree, (panel) => {
    const index = panel.tabs.findIndex((tab) => tab.action === action)
    if (index === -1) return panel
    const tabs = panel.tabs.filter((tab) => tab.action !== action)
    const active = panel.active !== action ? panel.active : (tabs[index] ?? tabs[index - 1])?.action ?? null
    return { ...panel, tabs, active, open: panel.open && tabs.length > 0 }
  })
}

/** Shows or hides the panel; a worktree with nothing run has nothing to show. */
export function setPanelOpen(panels: RunPanels, worktree: string, open: boolean): RunPanels {
  return withPanel(panels, worktree, (panel) => ({ ...panel, open: open && panel.tabs.length > 0 }))
}
