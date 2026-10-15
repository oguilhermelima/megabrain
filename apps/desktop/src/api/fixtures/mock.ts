import type { ChatRead, CodeChange, CodeDiff, CodeEntry, DoctorReport, InstallEvent, InstallPlan, Status, Transcript, Worktree } from '@/api/schema'

// Hand-made data for running the UI in a browser. Its shapes are checked against the same schemas as
// the payloads captured from the real CLI in ./captured (see schema.test.ts).

const home = '/Users/operator'
const now = '2026-10-14T21:40:00.000Z'

export const mockInstallPlan: InstallPlan = {
  version: '0.2.4',
  hosts: { orca: true, superset: false, tmux: true },
  agents: [
    { agent: 'claude', label: 'Claude Code', installed: true, configDir: `${home}/.claude` },
    { agent: 'codex', label: 'Codex', installed: true, configDir: `${home}/.codex` },
    { agent: 'agy', label: 'Antigravity (agy)', installed: false, configDir: `${home}/.gemini/config` },
    { agent: 'grok', label: 'Grok', installed: true, configDir: `${home}/.grok` },
  ],
  modules: [
    { module: 'orchestration', label: 'Orchestration', hint: 'dispatch and supervise agents in Orca, Superset or tmux', group: 'Agents', selectedByDefault: true, unavailable: false, reason: null },
    { module: 'orchestration-hooks', label: 'Turn-end hooks', hint: 'tell the parent when a child finishes its turn', group: 'Agents', selectedByDefault: true, unavailable: false, reason: null },
    { module: 'resource-hooks', label: 'Resource hooks', hint: 'route dev servers, docker and migrations into megabrain proc (opt-in)', group: 'Agents', selectedByDefault: false, unavailable: false, reason: null },
    { module: 'worktree', label: 'Shared worktrees', hint: 'one worktree folder for Orca and Superset', group: 'Agents', selectedByDefault: true, unavailable: false, reason: null },
    { module: 'simulator-web', label: 'Web browser testing', hint: 'Playwright MCP with Chromium and Firefox profiles', group: 'Testing', selectedByDefault: true, unavailable: false, reason: null },
    { module: 'simulator-native', label: 'iOS simulators', hint: 'Appium and the xcuitest driver', group: 'Testing', selectedByDefault: false, unavailable: false, reason: null },
    { module: 'simulator-tv', label: 'Apple TV simulator', hint: 'tvOS on the same xcuitest toolchain', group: 'Testing', selectedByDefault: false, unavailable: false, reason: null },
    { module: 'tv-adb', label: 'Android TV over adb', hint: 'a physical or emulated Android TV', group: 'Testing', selectedByDefault: false, unavailable: true, reason: 'adb is not on PATH' },
  ],
  defaults: { agents: ['claude', 'codex', 'grok'], skill: 'global', tmux: 'yes', modules: ['orchestration', 'orchestration-hooks', 'worktree', 'simulator-web'] },
  previous: null,
}

export const mockInstallRun: InstallEvent[] = [
  { type: 'intro', version: mockInstallPlan.version, hosts: mockInstallPlan.hosts, agents: mockInstallPlan.agents },
  { type: 'step', label: 'Installing the megabrain skill', state: 'start' },
  { type: 'step', label: 'Installing the megabrain skill', state: 'done', message: 'claude, codex, grok' },
  { type: 'step', module: 'tmux-runtime', label: 'Setting up tmux', state: 'start' },
  { type: 'step', module: 'tmux-runtime', label: 'Setting up tmux', state: 'done' },
  { type: 'step', module: 'orchestration', label: 'Setting up Orchestration', state: 'start' },
  { type: 'step', module: 'orchestration', label: 'Setting up Orchestration', state: 'done' },
  { type: 'step', module: 'orchestration-hooks', label: 'Setting up Turn-end hooks', state: 'start' },
  { type: 'warn', message: 'Codex shows a "Hooks need review" prompt on its next launch.' },
  { type: 'step', module: 'orchestration-hooks', label: 'Setting up Turn-end hooks', state: 'done' },
  { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'start' },
  { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'fail', message: 'Shared worktrees: missing (superset CLI is not on PATH)' },
  { type: 'step', module: 'simulator-web', label: 'Setting up Web browser testing', state: 'start' },
  { type: 'info', message: 'Downloading Chromium and Firefox; this can take a few minutes.' },
  { type: 'step', module: 'simulator-web', label: 'Setting up Web browser testing', state: 'done' },
  { type: 'confirm', message: 'Remove Apple TV simulator?', answer: false },
  {
    type: 'result',
    ok: false,
    message: 'Everything else is set up. Shared worktrees was not; fix what is shown above and run megabrain install again, or leave it unselected.',
    configured: ['tmux-runtime', 'orchestration', 'orchestration-hooks', 'simulator-web'],
    failed: [{ module: 'worktree', message: 'Shared worktrees: missing (superset CLI is not on PATH)' }],
  },
]

export const mockDoctor: DoctorReport = [
  { module: 'orchestration', status: 'ok', reason: 'usable runtimes: orca, tmux' },
  { module: 'orchestration-hooks', status: 'misconfigured', reason: 'claude: entry-present; codex: entry-present; grok: entry-missing' },
  { module: 'resource-hooks', status: 'missing', reason: 'module is not installed (opt-in)' },
  { module: 'worktree', status: 'misconfigured', reason: 'Superset worktreeBaseDir is unset or unreadable' },
  { module: 'simulator-web', status: 'ok', reason: 'chromium and firefox profiles ready' },
  { module: 'simulator-native', status: 'missing', reason: 'module is not installed' },
  { module: 'simulator-tv', status: 'missing', reason: 'module is not installed' },
  { module: 'tv-adb', status: 'unknown', reason: 'adb is not on PATH' },
]

function dispatch(id: string, fields: Partial<Status['dispatches'][number]>): Status['dispatches'][number] {
  return {
    dispatchId: `dispatch-20261014${id}`,
    state: 'running',
    agent: 'codex',
    model: 'gpt-6-luna',
    branch: null,
    worktreePath: null,
    chatName: null,
    label: null,
    owner: 'mine',
    parentSessionId: 'claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d',
    parentHost: 'local',
    agentSessionId: null,
    createdAt: '2026-10-14T20:58:12.000Z',
    updatedAt: now,
    supervision: { lastCheck: now, finding: null },
    ...fields,
  }
}

export const mockStatus: Status = {
  generatedAt: now,
  context: { host: 'local' },
  machine: {
    totalMemoryBytes: 19_327_352_832,
    availableMemoryBytes: 5_368_709_120,
    pressure: 'normal',
    swapUsedBytes: 2_147_483_648,
    loadAverage1: 6.4,
    loadAverage5: 5.1,
    cpuCount: 11,
  },
  supervisor: { watcher: { running: true, pid: 80163 } },
  dispatches: [
    dispatch('205812000-41022-7a1c9e03', {
      agentSessionId: 'codex:019a7c2e-0000-7e20-a3c4-8d9e0f1a2b3c',
      branch: 'feat/desktop-panel',
      chatName: 'feat/desktop-panel',
      worktreePath: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel',
    }),
    dispatch('210344000-41100-5d2e8c19', {
      branch: 'fix/player-seek',
      chatName: 'fix/player-seek',
      worktreePath: '/Users/operator/Workspaces/Worktrees/fix-player-seek',
      supervision: {
        lastCheck: now,
        finding: { cause: 'asks-you', errorText: 'Keep the old seek bar on tvOS, or use the new scrubber?', recommendation: 'answer with megabrain orchestrate reply 5d2e8c19 --text "…"' },
      },
    }),
    dispatch('211800000-41200-77aa01ce', {
      agent: 'claude',
      model: 'claude-sonnet-5',
      branch: 'feat/web-community-redesign',
      chatName: 'feat/web-community-redesign',
      worktreePath: '/Users/operator/Workspaces/Worktrees/feat-web-community-redesign',
      parentSessionId: 'codex:4b2f9a10-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    }),
    dispatch('212200000-41250-3c4d5e6f', {
      agent: 'claude',
      model: 'claude-sonnet-5',
      branch: 'feat/desktop-panel-columns',
      chatName: 'feat/desktop-panel-columns',
      worktreePath: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel-columns',
      parentSessionId: 'codex:019a7c2e-0000-7e20-a3c4-8d9e0f1a2b3c',
    }),
    dispatch('190000000-40000-1f0e0d0c', { state: 'failed', branch: 'chore/agy-trust-probe', chatName: 'chore/agy-trust-probe', updatedAt: '2026-09-26T10:00:00.000Z' }),
    dispatch('211504000-41388-b2d40f71', {
      agent: 'claude',
      model: 'claude-sonnet-5',
      branch: 'fix/queue-cancel-owner',
      chatName: 'fix/queue-cancel-owner',
      worktreePath: '/Users/operator/Workspaces/Worktrees/fix-queue-cancel-owner',
      supervision: {
        lastCheck: now,
        finding: {
          cause: 'usage-limit',
          resetAt: '2026-10-14T23:00:00.000Z',
          errorText: "You've hit your usage limit",
          recommendation: 'wait for the reset at 23:00, then megabrain orchestrate reply 7f3e2b10 --text "continue"',
        },
      },
    }),
    dispatch('212930000-41502-0c88e4d2', {
      agent: 'grok',
      model: 'grok-5',
      state: 'done',
      branch: 'docs/status-command',
      chatName: 'docs/status-command',
      owner: 'foreign',
      parentSessionId: 'codex:019a7c2e-55b1-7e20-a3c4-8d9e0f1a2b3c',
    }),
    dispatch('213345000-41620-9e51aa07', {
      state: 'queued',
      branch: 'refactor/proc-runner',
      chatName: 'refactor/proc-runner',
    }),
  ],
  queue: [
    {
      id: 'dispatch-20261014213345000-41620-9e51aa07',
      kind: 'spawn',
      dispatch: 'dispatch-20261014213345000-41620-9e51aa07',
      type: 'spawn',
      createdAt: '2026-10-14T21:33:45.000Z',
      state: 'queued',
      text: 'waiting for memory: 5.0 GiB available, policy needs 6.0 GiB',
    },
  ],
  processes: [{ name: 'web', state: 'running', pid: 51234, worktree: '/Users/operator/Workspaces/canto' }],
  resources: { history: false, admission: null },
  deliveryChannels: [{ agent: 'claude', channel: 'peer-socket', status: 'working' }],
}

export const mockWorktrees: Worktree[] = [
  { path: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel', branch: 'feat/desktop-panel', parent: null, pullRequest: { number: 83, state: 'OPEN', url: 'https://github.com/oguilhermelima/megabrain/pull/83' }, repository: { name: 'megabrain', path: '/Users/operator/Workspaces/megabrain' } },
  { path: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel-columns', branch: 'feat/desktop-panel-columns', parent: 'feat/desktop-panel', pullRequest: { number: 84, state: 'OPEN', url: 'https://github.com/oguilhermelima/megabrain/pull/84' }, repository: { name: 'megabrain', path: '/Users/operator/Workspaces/megabrain' } },
  { path: '/Users/operator/Workspaces/Worktrees/fix-queue-cancel-owner', branch: 'fix/queue-cancel-owner', repository: { name: 'megabrain', path: '/Users/operator/Workspaces/megabrain' } },
  { path: '/Users/operator/Workspaces/Worktrees/fix-player-seek', branch: 'fix/player-seek', repository: { name: 'canto', path: '/Users/operator/Workspaces/canto' } },
  { path: '/Users/operator/Workspaces/Worktrees/feat-web-community-redesign', branch: 'feat/web-community-redesign', repository: { name: 'juntin', path: '/Users/operator/Workspaces/juntin' } },
]

export const mockChatRead: ChatRead = {
  dispatchId: 'dispatch-20261014210344000-41100-5d2e8c19',
  source: 'tmux',
  truncated: false,
  text: [
    '• Ran bun test apps/tv/player',
    '  ✓ seek forward 10s keeps playback rate',
    '  ✓ seek backward clamps at 0',
    '  ! seek bar on tvOS: two designs disagree',
    '',
    '• Asked the coordinator',
    '  megabrain ask "Keep the old seek bar on tvOS, or use the new',
    '  scrubber from the web player? The new one needs focus handling',
    '  for the remote."',
    '',
    'waiting for a reply…',
  ].join('\n'),
}

const at = (minute: number) => `2026-10-14T21:${String(minute).padStart(2, '0')}:00.000Z`

export const mockTranscript: Transcript = {
  dispatchId: 'dispatch-20261014210344000-41100-5d2e8c19',
  sessionId: 'codex:019a7c2e-55b1-7e20-a3c4-8d9e0f1a2b3c',
  agent: 'codex',
  source: 'codex',
  cursor: 'mock-12',
  events: [
    { id: 'e1', at: at(3), kind: 'user', text: 'Fix seeking in the TV player: seeking forward 10s resets the playback rate, and seeking back past 0 crashes. Tests first.' },
    { id: 'e2', at: at(3), kind: 'thinking', text: 'The rate reset probably comes from recreating the AVPlayerItem on seek. I should look at usePlayerSeek and the tvOS adapter before writing tests.' },
    { id: 'e3', at: at(4), kind: 'tool-call', text: 'rg -n "seekBy|setRate" apps/tv/player', tool: { name: 'shell', input: 'rg -n "seekBy|setRate" apps/tv/player' } },
    { id: 'e4', at: at(4), kind: 'tool-result', text: 'apps/tv/player/use-player-seek.ts:41:  player.replaceCurrentItem(item)\napps/tv/player/use-player-seek.ts:58:  player.setRate(1)', tool: { name: 'shell', status: 'ok' } },
    { id: 'e5', at: at(5), kind: 'assistant', text: 'Seeking replaces the current item, which resets the rate to 1. I will write two tests: one that keeps the rate across a forward seek, one that clamps a backward seek at 0.' },
    { id: 'e6', at: at(7), kind: 'tool-call', text: 'apply_patch apps/tv/player/use-player-seek.test.ts', tool: { name: 'apply_patch', input: '*** Add File: apps/tv/player/use-player-seek.test.ts' } },
    { id: 'e7', at: at(7), kind: 'tool-result', text: 'Success. Updated 1 file.', tool: { name: 'apply_patch', status: 'ok' } },
    { id: 'e8', at: at(9), kind: 'tool-call', text: 'bun test apps/tv/player', tool: { name: 'shell', input: 'bun test apps/tv/player' } },
    { id: 'e9', at: at(9), kind: 'tool-result', text: '2 pass\n0 fail', tool: { name: 'shell', status: 'ok' } },
    { id: 'e10', at: at(10), kind: 'thinking', text: 'The seek bar question is a design decision, not mine. Two designs disagree; ask the coordinator.' },
    { id: 'e11', at: at(11), kind: 'tool-call', text: 'megabrain ask "Keep the old seek bar on tvOS, or use the new scrubber?"', tool: { name: 'shell', input: 'megabrain ask …' } },
    { id: 'e12', at: at(11), kind: 'system', text: 'Waiting for a reply from the coordinator.' },
  ],
}

export const mockCodeTree: CodeEntry[] = [
  { path: 'apps', kind: 'dir', size: null },
  { path: 'apps/tv', kind: 'dir', size: null },
  { path: 'apps/tv/player', kind: 'dir', size: null },
  { path: 'apps/tv/player/use-player-seek.ts', kind: 'file', size: 2140 },
  { path: 'apps/tv/player/use-player-seek.test.ts', kind: 'file', size: 980 },
  { path: 'apps/tv/player/seek-bar.tsx', kind: 'file', size: 3312 },
  { path: 'package.json', kind: 'file', size: 812 },
  { path: 'README.md', kind: 'file', size: 4210 },
]

export const mockCodeFiles: Record<string, string> = {
  'apps/tv/player/use-player-seek.ts': [
    "import { useCallback } from 'react'",
    "import type { Player } from './player'",
    '',
    'export function usePlayerSeek(player: Player) {',
    '  return useCallback((seconds: number) => {',
    '    const rate = player.rate',
    '    const target = Math.max(0, player.currentTime + seconds)',
    '    player.seek(target)',
    '    player.setRate(rate)',
    '  }, [player])',
    '}',
  ].join('\n'),
  'package.json': '{\n  "name": "canto",\n  "private": true\n}',
  'README.md': '# canto\n\nMedia apps for web, phone and TV.',
}

export const mockCodeChanges: CodeChange[] = [
  { path: 'apps/tv/player/use-player-seek.ts', status: 'modified' },
  { path: 'apps/tv/player/use-player-seek.test.ts', status: 'added' },
]

export const mockCodeDiff: CodeDiff = {
  path: 'apps/tv/player/use-player-seek.ts',
  original: [
    "import { useCallback } from 'react'",
    "import type { Player } from './player'",
    '',
    'export function usePlayerSeek(player: Player) {',
    '  return useCallback((seconds: number) => {',
    '    player.replaceCurrentItem(player.item)',
    '    player.seek(player.currentTime + seconds)',
    '    player.setRate(1)',
    '  }, [player])',
    '}',
  ].join('\n'),
  modified: mockCodeFiles['apps/tv/player/use-player-seek.ts'] ?? '',
  binary: false,
  tooLarge: false,
}
