import { describe, expect, test } from 'bun:test'
import { projectScriptsSchema, type ProjectScripts } from '@/api/schema'
import { closeTab, commandFor, isRunning, liveRuns, markExited, markStarted, needsSetup, panelFor, primaryAction, runActions, runShellCommand, selectTab, setPanelOpen, startRun, type RunPanels } from '@/run-panel/run-model'

const scripts = (fields: Partial<ProjectScripts['scripts']> = {}): ProjectScripts => ({
  repo: '/repo',
  scripts: { run: null, build: null, install: null, ...fields },
})

const a = '/work/a'
const b = '/work/b'

describe('projectScriptsSchema', () => {
  test('reads the CLI contract: saved, detected and missing commands', () => {
    const parsed = projectScriptsSchema.parse({
      repo: '/Users/me/app',
      scripts: { run: { command: 'bun dev', source: 'saved' }, build: { command: 'bun run build', source: 'detected' }, install: null },
    })
    expect(parsed.scripts.run).toEqual({ command: 'bun dev', source: 'saved' })
    expect(parsed.scripts.install).toBeNull()
  })

  test('refuses a source the contract does not name', () => {
    expect(projectScriptsSchema.safeParse({ repo: '/r', scripts: { run: { command: 'x', source: 'guessed' }, build: null, install: null } }).success).toBe(false)
  })
})

describe('primaryAction', () => {
  test('is Run until an action has been used', () => {
    expect(primaryAction(null)).toBe('run')
    expect(primaryAction(undefined)).toBe('run')
  })

  test('is the last action used', () => {
    expect(primaryAction('build')).toBe('build')
    expect(primaryAction('install')).toBe('install')
  })

  test('follows the panel: starting an action makes it the primary one for that worktree only', () => {
    const panels = startRun({}, a, 'install', 'bun install')
    expect(primaryAction(panelFor(panels, a).last)).toBe('install')
    expect(primaryAction(panelFor(panels, b).last)).toBe('run')
  })
})

describe('Set up', () => {
  test('an action shows Set up when the project has no command for it', () => {
    const value = scripts({ run: { command: 'bun dev', source: 'detected' }, build: { command: '  ', source: 'saved' } })
    expect(runActions.map((action) => needsSetup(value, action))).toEqual([false, true, true])
    expect(commandFor(value, 'run')).toBe('bun dev')
    expect(commandFor(value, 'build')).toBeNull()
    expect(commandFor(value, 'install')).toBeNull()
  })

  test('every action shows Set up while the scripts are unknown', () => {
    expect(runActions.every((action) => needsSetup(null, action))).toBe(true)
  })

  test('the menu lists Run, Build and Install in that order', () => {
    expect(runActions).toEqual(['run', 'build', 'install'])
  })
})

describe('runShellCommand', () => {
  test('runs the command through the login shell', () => {
    const argv = runShellCommand('bun dev')
    expect(argv.at(-1)).toBe('bun dev')
    expect(argv.join(' ')).toContain('-lc')
  })
})

describe('run panel tabs', () => {
  test('a worktree with nothing run has a closed panel and no tabs', () => {
    expect(panelFor({}, a)).toEqual({ open: false, tabs: [], active: null, last: null })
  })

  test('running an action opens the panel on its tab, one tab per action', () => {
    let panels: RunPanels = startRun({}, a, 'run', 'bun dev')
    panels = startRun(panels, a, 'build', 'bun run build')
    const panel = panelFor(panels, a)
    expect(panel.open).toBe(true)
    expect(panel.active).toBe('build')
    expect(panel.tabs.map((tab) => tab.action)).toEqual(['run', 'build'])
    expect(panel.tabs[0]).toMatchObject({ command: 'bun dev', status: { kind: 'starting' }, terminalId: null })
  })

  test('each worktree keeps its own panel', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    panels = startRun(panels, b, 'install', 'npm ci')
    expect(panelFor(panels, a).tabs.map((tab) => tab.action)).toEqual(['run'])
    expect(panelFor(panels, b).tabs.map((tab) => tab.action)).toEqual(['install'])
    panels = setPanelOpen(panels, a, false)
    expect(panelFor(panels, a).open).toBe(false)
    expect(panelFor(panels, b).open).toBe(true)
  })

  test('running an action again replaces its tab with a new run and the current command', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    const first = panelFor(panels, a).tabs[0]
    panels = markStarted(panels, a, 'run', first?.generation ?? -1, 'term-1')
    panels = startRun(panels, a, 'run', 'bun dev --port 4000')
    const tabs = panelFor(panels, a).tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.command).toBe('bun dev --port 4000')
    expect(tabs[0]?.terminalId).toBeNull()
    expect(tabs[0]?.generation).not.toBe(first?.generation)
  })

  test('a tab runs while starting or started, and stops counting once it exits', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    expect(isRunning(panels, a, 'run')).toBe(true)
    const generation = panelFor(panels, a).tabs[0]?.generation ?? -1
    panels = markStarted(panels, a, 'run', generation, 'term-1')
    expect(panelFor(panels, a).tabs[0]).toMatchObject({ terminalId: 'term-1', status: { kind: 'running' } })
    expect(isRunning(panels, a, 'run')).toBe(true)
    panels = markExited(panels, a, 'run', generation, 2)
    expect(panelFor(panels, a).tabs[0]?.status).toEqual({ kind: 'exited', code: 2 })
    expect(isRunning(panels, a, 'run')).toBe(false)
    expect(isRunning(panels, a, 'build')).toBe(false)
    expect(isRunning(panels, b, 'run')).toBe(false)
  })

  test('news from a replaced run does not touch the new one', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    const old = panelFor(panels, a).tabs[0]?.generation ?? -1
    panels = startRun(panels, a, 'run', 'bun dev')
    panels = markExited(panels, a, 'run', old, 143)
    panels = markStarted(panels, a, 'run', old, 'term-old')
    expect(panelFor(panels, a).tabs[0]).toMatchObject({ status: { kind: 'starting' }, terminalId: null })
  })

  test('closing a tab moves to its neighbour, and closing the last one closes the panel', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    panels = startRun(panels, a, 'build', 'bun run build')
    panels = startRun(panels, a, 'install', 'bun install')
    panels = selectTab(panels, a, 'build')
    expect(panelFor(panels, a).active).toBe('build')
    panels = closeTab(panels, a, 'build')
    expect(panelFor(panels, a).tabs.map((tab) => tab.action)).toEqual(['run', 'install'])
    expect(panelFor(panels, a).active).toBe('install')
    panels = closeTab(panels, a, 'install')
    expect(panelFor(panels, a).active).toBe('run')
    panels = closeTab(panels, a, 'run')
    expect(panelFor(panels, a)).toMatchObject({ open: false, tabs: [], active: null })
  })

  test('the last action used outlives closing its tab', () => {
    let panels = startRun({}, a, 'build', 'bun run build')
    panels = closeTab(panels, a, 'build')
    expect(panelFor(panels, a).last).toBe('build')
  })

  test('opening the panel of a worktree with no tabs keeps it closed', () => {
    expect(panelFor(setPanelOpen({}, a, true), a).open).toBe(false)
  })
})

describe('liveRuns', () => {
  test('counts the runs that are starting or running, not the exited ones', () => {
    let panels = startRun({}, a, 'run', 'bun dev')
    panels = startRun(panels, a, 'build', 'bun run build')
    panels = startRun(panels, a, 'install', 'bun install')
    const run = panelFor(panels, a).tabs[0]
    const install = panelFor(panels, a).tabs[2]
    if (run === undefined || install === undefined) throw new Error('missing tabs')
    panels = markStarted(panels, a, 'run', run.generation, 'term-1')
    panels = markExited(panels, a, 'install', install.generation, 0)
    expect(liveRuns(panelFor(panels, a))).toBe(2)
  })

  test('keeps counting a hidden panel, because hiding stops nothing', () => {
    const panels = setPanelOpen(startRun({}, a, 'run', 'bun dev'), a, false)
    expect(panelFor(panels, a).open).toBe(false)
    expect(panelFor(panels, a).tabs).toHaveLength(1)
    expect(liveRuns(panelFor(panels, a))).toBe(1)
  })

  test('is zero for a worktree that never ran anything', () => {
    expect(liveRuns(panelFor({}, b))).toBe(0)
  })
})
