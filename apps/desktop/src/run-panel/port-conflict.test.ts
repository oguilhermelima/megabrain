import { describe, expect, test } from 'bun:test'
import { portListenersSchema, projectScriptsSchema, type PortListener, type ScriptPort } from '@/api/schema'
import { addressInUse, commandOnPort, holderSentence, portConflict } from '@/run-panel/port-conflict'
import { markExited, panelFor, runTabTitle, setConflict, startRun, type RunPanels } from '@/run-panel/run-model'

const NOW = Date.parse('2026-10-16T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const next: ScriptPort = { port: 3000, framework: 'next', source: 'default', detail: 'next dev listens on 3000 by default', fragment: null, override: '--port {port}' }

const holder = (fields: Partial<PortListener> = {}): PortListener => ({
  pid: 730,
  command: 'next-server',
  args: 'next-server (v15.0.0)',
  cwd: '/work/canto-main',
  startedAt: minutesAgo(12),
  place: { root: '/work/canto-main', project: 'canto', branch: 'main' },
  managed: null,
  ...fields,
})

describe('the CLI contract', () => {
  test('repo scripts carries the run port, and an older CLI without it still parses', () => {
    const base = { repo: '/r', scripts: { run: { command: 'pnpm run dev', source: 'detected' }, build: null, install: null } }
    expect(projectScriptsSchema.parse({ ...base, port: next }).port).toEqual(next)
    expect(projectScriptsSchema.parse({ ...base, port: null }).port).toBeNull()
    expect(projectScriptsSchema.parse(base).port).toBeUndefined()
  })

  test('port who parses with managed holders of both kinds', () => {
    const parsed = portListenersSchema.parse({
      port: 3000,
      listeners: [holder({ managed: { kind: 'proc', name: 'web', worktree: '/w' } }), holder({ pid: 2, managed: { kind: 'app-terminal', session: 'mb-app-1', title: 'Run' } })],
    })
    expect(parsed.listeners).toHaveLength(2)
  })
})

describe('commandOnPort', () => {
  test('a framework default gets PORT and the framework flag', () => {
    expect(commandOnPort('pnpm run dev', next, 3001)).toBe('PORT=3001 pnpm run dev --port 3001')
  })

  test('npm needs -- before the script arguments', () => {
    expect(commandOnPort('npm run dev', next, 3001)).toBe('PORT=3001 npm run dev -- --port 3001')
    expect(commandOnPort('npm start', next, 3001)).toBe('PORT=3001 npm start -- --port 3001')
  })

  test('a port written into the run command is replaced where it stands', () => {
    expect(commandOnPort('vite --port 4000 --host', { ...next, framework: 'vite', port: 4000, source: 'command', fragment: '--port 4000' }, 4001)).toBe('vite --port 4001 --host')
    expect(commandOnPort('PORT=5000 node server.js', { ...next, framework: null, port: 5000, source: 'command', fragment: 'PORT=5000', override: null }, 5001)).toBe('PORT=5001 node server.js')
  })

  test('a framework that only reads PORT gets PORT alone', () => {
    expect(commandOnPort('npm run dev', { ...next, framework: 'remix', override: null }, 3001)).toBe('PORT=3001 npm run dev')
    expect(commandOnPort('npm run dev', { ...next, framework: null, source: 'env-file', override: null }, 3001)).toBe('PORT=3001 npm run dev')
  })

  test('django takes the port as an argument', () => {
    expect(commandOnPort('python manage.py runserver', { ...next, framework: 'django', port: 8000, override: '{port}' }, 8001)).toBe('PORT=8001 python manage.py runserver 8001')
  })

  test('a port fixed inside a package script cannot be moved from outside', () => {
    expect(commandOnPort('bun run storybook', { ...next, framework: 'storybook', port: 6007, source: 'script', override: null }, 6008)).toBeNull()
    expect(commandOnPort('npm run dev', { ...next, framework: null, port: 8088, source: 'package-json', override: null }, 8089)).toBeNull()
  })
})

describe('holderSentence', () => {
  test('names the process, its project and branch, and its age', () => {
    expect(holderSentence(holder(), NOW)).toBe('next-server in canto · main, started 12 min ago')
  })

  test('falls back to the folder, then to nothing', () => {
    expect(holderSentence(holder({ place: null, cwd: '/work/api', startedAt: minutesAgo(0.2) }), NOW)).toBe('next-server in api, started just now')
    expect(holderSentence(holder({ place: null, cwd: null, startedAt: null }), NOW)).toBe('next-server')
  })

  test('hours and days', () => {
    expect(holderSentence(holder({ place: null, cwd: null, startedAt: minutesAgo(150) }), NOW)).toBe('next-server, started 2 h ago')
    expect(holderSentence(holder({ place: null, cwd: null, startedAt: minutesAgo(60 * 50) }), NOW)).toBe('next-server, started 2 days ago')
  })

  test('says which megabrain process or app terminal it is', () => {
    expect(holderSentence(holder({ place: null, cwd: null, startedAt: null, managed: { kind: 'proc', name: 'web', worktree: '/w' } }), NOW)).toBe('next-server (megabrain proc web)')
    expect(holderSentence(holder({ place: null, cwd: null, startedAt: null, managed: { kind: 'app-terminal', session: 'mb-app-1', title: 'Run canto' } }), NOW)).toBe('next-server (app terminal Run canto)')
  })
})

describe('portConflict', () => {
  const base = { worktree: '/work/other', command: 'pnpm run dev', found: next, free: 3001, now: NOW }

  test('a free port is no conflict', () => {
    expect(portConflict({ ...base, listeners: [] })).toBeNull()
  })

  test('another worktree holds it: kill it and run, or use the next free port', () => {
    expect(portConflict({ ...base, listeners: [holder()] })).toEqual({
      port: 3000,
      title: 'Port 3000 is in use',
      body: 'Port 3000 is used by next-server in canto · main, started 12 min ago.',
      primary: 'kill',
      primaryLabel: 'Kill it and run',
      alternative: { port: 3001, command: 'PORT=3001 pnpm run dev --port 3001', label: 'Use 3001' },
    })
  })

  test('this worktree holds it: Restart', () => {
    const conflict = portConflict({ ...base, worktree: '/work/canto-main', listeners: [holder()] })
    expect(conflict).toMatchObject({ primary: 'restart', primaryLabel: 'Restart' })
    expect(conflict?.body).toContain("this worktree's earlier run")
  })

  test('a holder in a subfolder of this worktree is still its own run; a sibling path is not', () => {
    expect(portConflict({ ...base, worktree: '/work/canto-main', listeners: [holder({ cwd: '/work/canto-main/apps/web' })] })?.primary).toBe('restart')
    expect(portConflict({ ...base, worktree: '/work/canto', listeners: [holder({ cwd: '/work/canto-main' })] })?.primary).toBe('kill')
  })

  test('no free port or no way to move the command leaves only kill and cancel', () => {
    expect(portConflict({ ...base, free: null, listeners: [holder()] })?.alternative).toBeNull()
    expect(portConflict({ ...base, found: { ...next, source: 'script', override: null }, listeners: [holder()] })?.alternative).toBeNull()
  })

  test('several holders are counted', () => {
    expect(portConflict({ ...base, listeners: [holder(), holder({ pid: 731 })] })?.body).toBe('Port 3000 is used by next-server in canto · main, started 12 min ago, and 1 more process.')
  })
})

describe('addressInUse', () => {
  test('reads the port from the common messages', () => {
    expect(addressInUse('Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle')).toEqual({ port: 3000 })
    expect(addressInUse('OSError: [Errno 48] Address already in use')).toEqual({ port: null })
    expect(addressInUse('Error: Port 6006 is in use')).toEqual({ port: 6006 })
    expect(addressInUse('Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)')).toEqual({ port: 3000 })
  })

  test('ordinary output is not a conflict', () => {
    expect(addressInUse('ready - started server on 0.0.0.0:3000')).toBeNull()
  })
})

describe('run tabs on another port', () => {
  test('the tab title says the port it moved to', () => {
    const panels = startRun({}, '/w', 'run', 'PORT=3001 pnpm run dev --port 3001', 3001)
    const tab = panelFor(panels, '/w').tabs[0]!
    expect(tab.movedTo).toBe(3001)
    expect(runTabTitle(tab)).toBe('Run · port 3001')
    expect(runTabTitle(panelFor(startRun({}, '/w', 'run', 'pnpm run dev'), '/w').tabs[0]!)).toBe('Run')
  })

  test('a failed run carries the conflict until it runs again', () => {
    let panels: RunPanels = startRun({}, '/w', 'run', 'pnpm run dev')
    const tab = panelFor(panels, '/w').tabs[0]!
    panels = markExited(panels, '/w', 'run', tab.generation, 1)
    const conflict = portConflict({ worktree: '/w', command: 'pnpm run dev', found: next, free: 3001, now: NOW, listeners: [holder()] })!
    panels = setConflict(panels, '/w', 'run', tab.generation, conflict)
    expect(panelFor(panels, '/w').tabs[0]?.conflict).toEqual(conflict)
    // News for an older generation is dropped.
    expect(setConflict(panels, '/w', 'run', tab.generation - 1, null)).toBe(panels)
    panels = startRun(panels, '/w', 'run', 'pnpm run dev')
    expect(panelFor(panels, '/w').tabs[0]?.conflict).toBeNull()
  })
})
