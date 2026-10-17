import type { Settings, GithubDetail, GithubPullRequestFile, GithubIssue, GithubIssueList, GithubPullRequest, GithubPullRequestList, GithubRepository, GithubOwner, DiscoveredRepository, HistorySession, Project, Repository, BranchChanges, ChatRead, CodeChange, CodeDiff, CodeEntry, DoctorReport, InstallEvent, InstallPlan, Status, Transcript, Worktree } from '@/api/schema'
import { measuredModels } from '@/api/fixtures/models'

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

export const mockDispatchReport = [
  'The new scrubber replaces the seek bar on tvOS, and the old bar stays behind a flag.',
  '',
  'Technical detail: SeekScrubber renders in the player overlay; the legacy bar is behind player.legacySeekBar. Gates: typecheck ok, unit 214 pass / 0 fail.',
  'git log: 4f2a1c90 feat(tv): add the seek scrubber; 9b3e7d12 test(tv): pin scrubber seeking',
].join('\n')

const at = (minute: number) => `2026-10-14T21:${String(minute).padStart(2, '0')}:00.000Z`

export const mockTranscript: Transcript = {
  dispatchId: 'dispatch-20261014210344000-41100-5d2e8c19',
  sessionId: 'codex:019a7c2e-55b1-7e20-a3c4-8d9e0f1a2b3c',
  agent: 'codex',
  source: 'codex',
  cursor: 'mock-12',
  events: [
    { id: 'e0', at: at(2), kind: 'user', text: '[megabrain dispatch: fix/player-seek]\nRun megabrain received before work.', origin: { kind: 'parent', label: 'Claude 5f1c2a7e', dispatchId: null, sessionId: 'claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d' } },
    { id: 'e1', at: at(3), kind: 'user', text: 'Fix seeking in the TV player: seeking forward 10s resets the playback rate, and seeking back past 0 crashes. Tests first.\n\nThe bar after seeking [Image #54] and the crash log [Image #55]\n\nRepro notes in `/Users/operator/Workspaces/canto/apps/tv/src/player/very/long/path/to/the/seek-controller.test.ts`.', images: [{ dataUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'%3E%3Crect width='320' height='200' fill='%23243447'/%3E%3Crect x='24' y='150' width='272' height='6' rx='3' fill='%23ffffff40'/%3E%3Crect x='24' y='150' width='120' height='6' rx='3' fill='%2360a5fa'/%3E%3C/svg%3E" }, { path: '/var/folders/x1/T/orca-paste-1792108380783-crash.png' }] },
    { id: 'e2', at: at(3), kind: 'thinking', text: 'The rate reset probably comes from recreating the AVPlayerItem on seek. I should look at usePlayerSeek and the tvOS adapter before writing tests.' },
    { id: 'e3', at: at(4), kind: 'tool-call', text: 'rg -n "seekBy|setRate" apps/tv/player', tool: { name: 'shell', input: 'rg -n "seekBy|setRate" apps/tv/player' } },
    { id: 'e4', at: at(4), kind: 'tool-result', text: 'apps/tv/player/use-player-seek.ts:41:  player.replaceCurrentItem(item)\napps/tv/player/use-player-seek.ts:58:  player.setRate(1)', tool: { name: 'shell', status: 'ok' } },
    { id: 'e5', at: at(5), kind: 'assistant', text: '**Cause:** seeking replaces the current item, which resets the rate to 1.\n\nPlan:\n1. a test that keeps the rate across a forward seek;\n2. a test that clamps a backward seek at `0`.\n\n| case | before | after |\n| --- | --- | --- |\n| +10s | rate 1 | rate kept |\n| -10s at 3s | crash | 0 |' },
    { id: 'e5b', at: at(6), kind: 'user', text: '✅ codex · feat/seek-bar finished — the scrubber is in — details: megabrain orchestrate watch 7a1c9e03', origin: { kind: 'child', label: 'feat/seek-bar', dispatchId: 'dispatch-20261014205812000-41022-7a1c9e03', sessionId: null } },
    // megabrain notices, one of each kind; the two stuck ones for one dispatch collapse into one card.
    { id: 'n1', at: at(6), kind: 'system', text: 'Message from megabrain: ⚠️ claude · feat/web-community-redesign is stuck\ndetails: megabrain orchestrate watch 77aa01ce', notice: { kind: 'stuck', agent: 'claude', label: 'feat/web-community-redesign', dispatchId: '77aa01ce', summary: 'claude · feat/web-community-redesign is stuck' }, origin: { kind: 'child', label: 'feat/web-community-redesign', dispatchId: 'dispatch-20261014211800000-41200-77aa01ce', sessionId: null } },
    { id: 'n2', at: at(6), kind: 'system', text: 'Message from megabrain: ⚠️ claude · feat/web-community-redesign is stuck\ndetails: megabrain orchestrate watch 77aa01ce', notice: { kind: 'stuck', agent: 'claude', label: 'feat/web-community-redesign', dispatchId: '77aa01ce', summary: 'claude · feat/web-community-redesign is still stuck' }, origin: { kind: 'child', label: 'feat/web-community-redesign', dispatchId: 'dispatch-20261014211800000-41200-77aa01ce', sessionId: null } },
    { id: 'n3', at: at(6), kind: 'system', text: 'Message from megabrain: ✅ codex · docs/status-command finished — the status page is documented\ndetails: megabrain orchestrate watch 0c88e4d2', notice: { kind: 'finished', agent: 'codex', label: 'docs/status-command', dispatchId: '0c88e4d2', summary: 'The status page is documented.' }, origin: { kind: 'child', label: 'docs/status-command', dispatchId: 'dispatch-20261014212930000-41502-0c88e4d2', sessionId: null } },
    { id: 'n4', at: at(6), kind: 'system', text: 'Message from megabrain: ❓ claude · feat/desktop-panel-columns has a question — keep three columns on a narrow window?\ndetails: megabrain orchestrate watch 3c4d5e6f', notice: { kind: 'ask', agent: 'claude', label: 'feat/desktop-panel-columns', dispatchId: '3c4d5e6f', summary: 'Keep three columns on a narrow window, or fold to two?' }, origin: { kind: 'child', label: 'feat/desktop-panel-columns', dispatchId: 'dispatch-20261014212200000-41250-3c4d5e6f', sessionId: null } },
    { id: 'n5', at: at(6), kind: 'system', text: 'Message from megabrain: ⚠️ codex · fix/queue-cancel-owner is stuck — usage limit\ndetails: megabrain orchestrate watch b2d40f71', notice: { kind: 'limit', agent: 'codex', label: 'fix/queue-cancel-owner', dispatchId: 'b2d40f71', summary: 'codex hit its usage limit; it resets at 23:00.' }, origin: { kind: 'child', label: 'fix/queue-cancel-owner', dispatchId: 'dispatch-20261014211504000-41388-b2d40f71', sessionId: null } },
    { id: 'n6', at: at(6), kind: 'system', text: 'Message from megabrain: ❌ agy · chore/agy-trust-probe failed\ndetails: megabrain orchestrate watch 1f0e0d0c', notice: { kind: 'failed', agent: 'agy', label: 'chore/agy-trust-probe', dispatchId: '1f0e0d0c', summary: 'The trust probe failed before it started.' }, origin: { kind: 'child', label: 'chore/agy-trust-probe', dispatchId: 'dispatch-20261014190000000-40000-1f0e0d0c', sessionId: null } },
    { id: 'n7', at: at(6), kind: 'system', text: 'Message from megabrain: ⚠️ claude · feat/desktop-panel is stuck\ndetails: megabrain orchestrate watch 7a1c9e03', notice: { kind: 'stuck', agent: 'codex', label: 'feat/desktop-panel', dispatchId: '7a1c9e03', summary: 'codex · feat/desktop-panel is stuck' }, origin: { kind: 'child', label: 'feat/desktop-panel', dispatchId: 'dispatch-20261014205812000-41022-7a1c9e03', sessionId: null } },
    { id: 'n8', at: at(6), kind: 'system', text: 'Message from megabrain: ℹ️ the supervisor restarted', notice: { kind: 'other', agent: null, label: null, dispatchId: null, summary: 'The supervisor restarted after an update.' } },
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

// More files than the Diff tab's list shows at once, so it scrolls.
export const mockCodeChanges: CodeChange[] = [
  { path: 'apps/tv/player/use-player-seek.ts', status: 'modified' },
  { path: 'apps/tv/player/use-player-seek.test.ts', status: 'added' },
  { path: '.notes/player-seek-inventory.md', status: 'untracked' },
  ...Array.from({ length: 36 }, (_, index): CodeChange => ({ path: `apps/tv/player/controls/control-${String(index + 1).padStart(2, '0')}.tsx`, status: index % 3 === 0 ? 'added' : 'modified' })),
]

export const mockBranchChanges: BranchChanges = {
  base: 'main',
  mergeBase: '4b6b7c76a1f0c3d2e5b8a9c7d6e5f4a3b2c1d0e9',
  changes: [
    { path: 'apps/tv/player/use-player-seek.ts', status: 'modified' },
    { path: 'apps/tv/player/seek-model.ts', status: 'added' },
  ],
}

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

// A new file: nothing on the original side, longer than the view and with lines wider than it.
export const mockNewFileDiff: CodeDiff = {
  path: '.notes/player-seek-inventory.md',
  original: '',
  modified: [
    '# Player seek inventory',
    '',
    'Scope: the seek controls as observed on 2026-10-15, on the TV and the phone players, with every path that moves the playhead and what each one does to the rate, the buffer and the captions while it runs.',
    ...Array.from({ length: 30 }, (_, section) => [
      '',
      `## ${section + 1}. Control ${section + 1}`,
      '',
      `- Seeks by ${(section + 1) * 5} seconds and keeps the rate the person chose (\`use-player-seek.ts:${section + 7}\`), then reports the new position to the scrubber, the captions and the remote's progress ring in one update.`,
      '- Leaves the buffer as it is when the target is already loaded.',
    ]).flat(),
  ].join('\n'),
  binary: false,
  tooLarge: false,
}

const ago = (minutes: number) => new Date(Date.parse('2026-10-15T12:00:00.000Z') - minutes * 60_000).toISOString()
const root = '/Users/operator/Workspaces'
const tree = '/Users/operator/Workspaces/Worktrees'

// `sessions history --cwd <canto> --json`: more Claude chats than one page holds, and one that the
// sidebar already lists (Desktop app as an agent IDE).
const past = (agent: HistorySession['agent'], id: string, title: string, minutes: number, messageCount: number | null): HistorySession => ({ agent, id, title, startedAt: ago(minutes + 45), lastActivityAt: ago(minutes), messageCount })
export const mockSessionHistory: HistorySession[] = [
  past('claude', '5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', 'Desktop app as an agent IDE', 0, 212),
  past('codex', '019a7c2e-1111-7000-8000-00000000000a', 'Queue cancel keeps the owner', 25, 38),
  past('claude', '7a000001-0000-4000-8000-000000000001', 'Audit Instagram paint on the home rails', 70, 64),
  past('grok', '0b1c2d3e-0000-4000-8000-000000000005', 'Probe the leader socket', 1900, null),
  past('claude', '7a000001-0000-4000-8000-000000000002', 'Native taste onboarding: first screen', 180, 41),
  past('agy', 'agy-3f2e1d0c', 'Seek bar polish on tvOS', 260, null),
  past('claude', '7a000001-0000-4000-8000-000000000003', 'Why the TV focus ring jumps', 400, 17),
  past('codex', '019a7c2e-1111-7000-8000-00000000000b', 'Rename the player hooks', 520, 90),
  past('claude', '7a000001-0000-4000-8000-000000000004', 'Migrate the icon sizes to the scale', 900, 133),
  past('claude', '7a000001-0000-4000-8000-000000000005', 'Drizzle journal check fails on CI', 1500, 22),
  past('claude', '7a000001-0000-4000-8000-000000000006', 'Community redesign, web', 2600, 75),
  past('claude', '7a000001-0000-4000-8000-000000000007', 'Profile header spacing', 4300, 9),
  past('claude', '7a000001-0000-4000-8000-000000000008', 'Release notes for 0.9', 7000, 12),
  past('claude', '7a000001-0000-4000-8000-000000000009', 'Search screen empty state', 9800, null),
].sort((left, right) => (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''))

export const mockProjects: Project[] = [
  {
    name: 'stack',
    path: `${root}/local/stack`,
    remote: null,
    source: 'import',
    missing: false,
    worktrees: [
      { path: `${root}/local/stack`, branch: 'main', head: 'a1b2c3d', primary: true, parent: null, pullRequest: null, sessions: [
        { agent: 'claude', sessionId: 'claude:0b1c2d3e-0000-4000-8000-000000000001', title: 'Monitoring backups', status: 'working', startedAt: ago(840), lastActivityAt: ago(1), dispatchId: null, origin: 'external' },
      ] },
    ],
  },
  {
    name: 'canto',
    path: `${root}/canto`,
    remote: 'https://github.com/operator/canto',
    source: 'megabrain',
    missing: false,
    worktrees: [
      { path: `${root}/canto`, branch: 'main', head: 'f00ba12', primary: true, parent: null, pullRequest: null, sessions: [
        { agent: 'claude', sessionId: 'claude:0b1c2d3e-0000-4000-8000-000000000002', title: 'Six visual changes on home', status: 'idle', startedAt: ago(90), lastActivityAt: ago(41), dispatchId: null, origin: 'megabrain', contextTokens: 412000, cacheExpiresAt: ago(41 - 60), idleCompactAt: ago(41 - 54) },
      ] },
      { path: `${tree}/fix-player-seek`, branch: 'fix/player-seek', head: 'c0ffee1', primary: false, parent: 'main', pullRequest: { number: 412, state: 'OPEN', url: 'https://github.com/operator/canto/pull/412' }, sessions: [
        { agent: 'codex', sessionId: 'codex:019a7c2e-55b1-7e20-a3c4-8d9e0f1a2b3c', title: 'fix/player-seek', status: 'waiting', startedAt: ago(60), lastActivityAt: ago(3), dispatchId: 'dispatch-20261014210344000-41100-5d2e8c19', origin: 'megabrain' },
      ] },
      { path: `${tree}/feat-extension`, branch: 'feat/extension', head: 'beef123', primary: false, parent: 'main', pullRequest: null, sessions: [
        { agent: 'codex', sessionId: 'codex:019a7c2e-0000-7000-8000-000000000003', title: 'feat/extension', status: 'idle', startedAt: ago(30), lastActivityAt: ago(0), dispatchId: null, origin: 'external' },
      ] },
      { path: `${tree}/canto-detached`, hidden: true, branch: null, head: '0fcc0b0', primary: false, parent: null, pullRequest: null, sessions: [] },
    ],
  },
  {
    name: 'megabrain',
    path: `${root}/megabrain`,
    remote: 'https://github.com/operator/megabrain',
    source: 'megabrain',
    missing: false,
    worktrees: [
      { path: `${root}/megabrain`, branch: 'main', head: '82d09a0', primary: true, parent: null, pullRequest: null, sessions: [
        { agent: 'claude', sessionId: 'claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d', title: 'Desktop app as an agent IDE', status: 'working', startedAt: ago(600), lastActivityAt: ago(0), dispatchId: null, origin: 'megabrain', owner: 'megabrain', tmuxServer: 'megabrain-app', tmuxSession: 'mb-claude-5f1c2a7e' },
      ] },
      { path: `${tree}/feat-desktop-panel`, branch: 'feat/desktop-panel', head: '1111111', primary: false, parent: 'main', pullRequest: { number: 83, state: 'OPEN', url: 'https://github.com/operator/megabrain/pull/83' }, sessions: [
        { agent: 'codex', sessionId: 'codex:019a7c2e-0000-7e20-a3c4-8d9e0f1a2b3c', title: 'feat/desktop-panel', status: 'working', startedAt: ago(40), lastActivityAt: ago(1), dispatchId: 'dispatch-20261014205812000-41022-7a1c9e03', origin: 'megabrain' },
      ] },
      { path: `${tree}/feat-desktop-panel-columns`, branch: 'feat/desktop-panel-columns', head: '2222222', primary: false, parent: 'feat/desktop-panel', pullRequest: { number: 84, state: 'OPEN', url: 'https://github.com/operator/megabrain/pull/84' }, sessions: [
        { agent: 'claude', sessionId: 'claude:0b1c2d3e-0000-4000-8000-000000000004', title: 'feat/desktop-panel-columns', status: 'working', startedAt: ago(20), lastActivityAt: ago(0), dispatchId: 'dispatch-20261014212200000-41250-3c4d5e6f', origin: 'megabrain' },
      ] },
      { path: `${tree}/chore-old-probe`, branch: 'chore/old-probe', head: '3333333', primary: false, parent: 'main', pullRequest: { number: 81, state: 'MERGED', url: 'https://github.com/operator/megabrain/pull/81' }, sessions: [
        { agent: 'grok', sessionId: 'grok:0b1c2d3e-0000-4000-8000-000000000005', title: 'probe the leader socket', status: 'ended', startedAt: ago(2000), lastActivityAt: ago(1900), dispatchId: null, origin: 'megabrain' },
      ] },
    ],
  },
  { name: 'archive', path: `${root}/archive`, remote: null, source: 'import', missing: false, hidden: true, worktrees: [] },
  { name: 'old-thing', path: `${root}/old-thing`, remote: null, source: 'import', missing: true, worktrees: [] },
]

export const mockGithubRepositories: GithubRepository[] = [
  { nameWithOwner: 'operator/canto', url: 'https://github.com/operator/canto', description: 'Media apps for web, phone and TV', isPrivate: true, updatedAt: ago(60), primaryLanguage: { name: 'TypeScript' }, stargazerCount: 3 },
  { nameWithOwner: 'operator/userscripts', url: 'https://github.com/operator/userscripts', description: null, isPrivate: false, updatedAt: ago(5000), primaryLanguage: { name: 'JavaScript' }, stargazerCount: 0 },
  { nameWithOwner: 'operator/dotfiles', url: 'https://github.com/operator/dotfiles', description: 'zsh, tmux and git configuration', isPrivate: false, updatedAt: ago(900), primaryLanguage: { name: 'Shell' }, stargazerCount: 14 },
  { nameWithOwner: 'operator/juntin', url: 'https://github.com/operator/juntin', description: 'Shared shopping lists', isPrivate: true, updatedAt: ago(2600), primaryLanguage: { name: 'Swift' }, stargazerCount: 1 },
  { nameWithOwner: 'acme-studio/storefront', url: 'https://github.com/acme-studio/storefront', description: 'The shop, its checkout and the admin', isPrivate: true, updatedAt: ago(180), primaryLanguage: { name: 'TypeScript' }, stargazerCount: 41 },
  { nameWithOwner: 'acme-studio/design-tokens', url: 'https://github.com/acme-studio/design-tokens', description: 'Colours, type and spacing for every surface', isPrivate: false, updatedAt: ago(14000), primaryLanguage: { name: 'CSS' }, stargazerCount: 268 },
  { nameWithOwner: 'acme-studio/infra', url: 'https://github.com/acme-studio/infra', description: null, isPrivate: true, updatedAt: ago(40000), primaryLanguage: { name: 'HCL' }, stargazerCount: 2 },
]

export const mockGithubOwners: GithubOwner[] = [
  { login: 'operator', kind: 'user', avatarUrl: null },
  { login: 'acme-studio', kind: 'organization', avatarUrl: null },
]

export const mockDiscovered: DiscoveredRepository[] = [
  { name: 'lostudio', path: `${root}/lostudio`, branch: 'main', remote: 'git@github.com:operator/lostudio.git', lastCommitAt: ago(35), root },
  { name: 'moide', path: `${root}/moide`, branch: 'feat/onboarding', remote: 'https://github.com/operator/moide', lastCommitAt: ago(300), root },
  { name: 'storefront', path: `${root}/clients/storefront`, branch: 'develop', remote: 'git@github.com:acme-studio/storefront.git', lastCommitAt: ago(1900), root },
  { name: 'scratch', path: '/Users/operator/code/scratch', branch: null, remote: null, lastCommitAt: ago(30000), root: '/Users/operator/code' },
  { name: 'gitlab-mirror', path: '/Users/operator/src/gitlab-mirror', branch: 'main', remote: 'https://gitlab.com/operator/mirror.git', lastCommitAt: null, root: '/Users/operator/src' },
]

export const mockImported = (path: string, remote: string | null): Repository => ({ name: path.split('/').at(-1) ?? path, path, remote, source: 'import', addedAt: ago(0) })

// Readings taken a moment before the mock starts, so the popover shows them as fresh.
const fresh = Math.floor(Date.now() / 1000) - 20

export const mockSettings: Settings = {
  supervisor: { running: true, pid: 21194 },
  resources: { historyEnabled: false, policy: null },
  limits: {
    enabledProviders: ['codex', 'claude'],
    notice: { enabled: true, intervalSeconds: 1800 },
    readings: [
      { provider: 'claude', window: '5h', status: 'current', usedPercent: 4, resetsAt: String(fresh + 3 * 3600 + 43 * 60), fetchedAt: fresh, reason: 'claude 5h window at 4 percent' },
      { provider: 'claude', window: 'weekly', status: 'current', usedPercent: 88, resetsAt: String(fresh + 5 * 86_400), fetchedAt: fresh, reason: 'claude weekly window at 88 percent' },
      { provider: 'codex', window: '5h', status: 'current', usedPercent: 17, resetsAt: String(fresh + 2 * 3600 + 28 * 60), fetchedAt: fresh - 2 * 3600, reason: 'codex 5h window at 17.0 percent' },
      { provider: 'codex', window: 'weekly', status: 'current', usedPercent: 66, resetsAt: String(fresh + 4 * 86_400 + 14 * 3600), fetchedAt: fresh - 2 * 3600, reason: 'codex weekly window at 66.0 percent' },
      // agy counts its own models and the others in separate pools.
      { provider: 'agy', window: '5h', bucket: 'Gemini Models', status: 'current', usedPercent: 7, resetsAt: String(fresh + 2 * 3600 + 28 * 60), fetchedAt: fresh, reason: 'agy 5h window (Gemini Models) at 7 percent', source: 'live' },
      { provider: 'agy', window: 'weekly', bucket: 'Gemini Models', status: 'current', usedPercent: 3, resetsAt: String(fresh + 4 * 86_400 + 14 * 3600), fetchedAt: fresh, reason: 'agy weekly window (Gemini Models) at 3 percent', source: 'live' },
      { provider: 'agy', window: '5h', bucket: 'Claude and GPT models', status: 'current', usedPercent: 46, resetsAt: String(fresh + 2 * 3600 + 28 * 60), fetchedAt: fresh, reason: 'agy 5h window (Claude and GPT models) at 46 percent', source: 'live' },
      { provider: 'agy', window: 'weekly', bucket: 'Claude and GPT models', status: 'current', usedPercent: 18, resetsAt: String(fresh + 4 * 86_400 + 14 * 3600), fetchedAt: fresh, reason: 'agy weekly window (Claude and GPT models) at 18 percent', source: 'live' },
      // The last good grok reading, kept while its sign-in has expired.
      { provider: 'grok', window: 'weekly', bucket: 'default', status: 'stale', usedPercent: 81, resetsAt: String(fresh + 30 * 3600), fetchedAt: fresh - 26 * 3600, reason: 'grok weekly window is stale (sign-in expired)', source: 'cache', stale: true, staleReason: 'sign-in expired' },
    ],
  },
  chains: [
    // Old-style rules, as every chains.json written before rules had groups.
    { name: 'claude', when: { parentAgent: 'claude' }, steps: [{ agent: 'codex', model: 'gpt-6-luna', effort: 'medium', until: { usedPercent: 95, window: '5h' } }, { agent: 'claude', model: 'claude-sonnet-5', effort: 'medium' }] },
    { name: 'codex', when: { parentAgent: 'codex' }, steps: [{ agent: 'claude', model: 'claude-sonnet-5', effort: 'high' }, { agent: 'agy', model: 'gemini-3.1-pro-high' }] },
    // Nested groups, usage, a step rule and a priority.
    {
      name: 'big-parents-to-luna',
      priority: 10,
      when: {
        all: [
          {
            any: [
              { parentAgent: 'claude', parentModel: 'claude-opus-5-5', parentEffort: ['low', 'medium', 'high'] },
              { parentAgent: 'codex', parentModel: 'gpt-6-astra', parentEffort: ['medium', 'high'] },
            ],
          },
          { usage: { provider: 'codex', window: 'weekly', below: 90 } },
        ],
      },
      steps: [
        { agent: 'codex', model: 'gpt-6-luna', effort: 'high', until: { usedPercent: 95, window: '5h' } },
        { agent: 'claude', model: 'claude-sonnet-5', effort: 'medium', when: { time: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '19:00' } } },
        { agent: 'agy', model: 'gemini-3.1-pro-high' },
      ],
    },
    { name: 'docs-on-megabrain', when: { repo: 'megabrain', label: 'docs*' }, steps: [{ agent: 'codex', model: 'gpt-6-luna', effort: 'low' }] },
  ],
  models: measuredModels,
  terminal: { default: null, detected: 'terminal', available: ['terminal', 'iterm', 'ghostty'] },
}

// One repository's pull requests and issues as `megabrain github prs|issues --state all --json` lists
// them: every state, drafts and labels in GitHub colors. Reviews, failing, pending and passing checks
// and line counts arrive with each pull request's detail, as `github pr --json` gives them.
const githubRef = { nameWithOwner: 'operator/megabrain', url: 'https://github.com/operator/megabrain', path: `${root}/megabrain` }
const person = (login: string, name: string | null = null) => ({ login, name, isBot: login.startsWith('app/') })
const label = (name: string, color: string, description = '') => ({ name, color, description })
const labels = {
  bug: label('bug', 'd73a4a', "Something isn't working"),
  enhancement: label('enhancement', 'a2eeef', 'New feature or request'),
  desktop: label('desktop', '5319e7', 'The desktop app'),
  docs: label('documentation', '0075ca', 'Improvements or additions to documentation'),
  deps: label('dependencies', '0366d6', 'Pull requests that update a dependency file'),
  triage: label('needs-triage', 'fbca04', 'Needs a first look'),
  good: label('good first issue', '7057ff', 'Good for newcomers'),
}
const check = (name: string, state: 'success' | 'failure' | 'pending' | 'skipped' | 'neutral') => ({ name, state })
const passing = [check('typecheck', 'success'), check('unit', 'success'), check('container', 'success'), check('release-please', 'skipped')]

type PullRequestDetail = Required<Pick<GithubDetail, 'reviewDecision' | 'checks' | 'additions' | 'deletions'>>
type MockPullRequest = GithubPullRequest & PullRequestDetail

const pullRequest = (fields: Partial<MockPullRequest> & Pick<MockPullRequest, 'number' | 'title' | 'headRefName'>): MockPullRequest => ({
  state: 'open',
  isDraft: false,
  author: person('operator', 'Operator'),
  labels: [],
  createdAt: ago(600),
  updatedAt: ago(60),
  url: `https://github.com/operator/megabrain/pull/${fields.number}`,
  baseRefName: 'main',
  reviewDecision: 'review_required',
  checks: passing,
  comments: 0,
  additions: 120,
  deletions: 14,
  ...fields,
})

const mockPullRequests: MockPullRequest[] = [
    pullRequest({ number: 112, title: 'feat(desktop): pull request and issue pages', headRefName: 'feat/desktop-github-pages', labels: [labels.desktop, labels.enhancement], comments: 3, additions: 1840, deletions: 62, updatedAt: ago(4), checks: [check('typecheck', 'success'), check('unit', 'pending'), check('container', 'pending')] }),
    pullRequest({ number: 111, title: 'fix(spawn): keep the launch line under the tmux limit', headRefName: 'fix/spawn-launch-line', labels: [labels.bug], reviewDecision: 'changes_requested', comments: 7, additions: 48, deletions: 31, updatedAt: ago(35), checks: [check('typecheck', 'success'), check('unit', 'failure'), check('container', 'success')] }),
    pullRequest({ number: 110, title: 'polish(desktop): move setup and watcher into settings', headRefName: 'polish/desktop-settings', labels: [labels.desktop], reviewDecision: 'approved', comments: 2, updatedAt: ago(90), author: person('fake-contributor', 'Fake Contributor') }),
    pullRequest({ number: 109, title: 'WIP: native capture for tvOS 27', headRefName: 'feat/native-capture-tvos', isDraft: true, reviewDecision: null, checks: [], additions: 410, deletions: 3, updatedAt: ago(200) }),
    pullRequest({ number: 108, title: 'docs(readme): document the github commands', headRefName: 'docs/github-commands', labels: [labels.docs], reviewDecision: null, checks: [check('typecheck', 'success'), check('ci/legacy', 'neutral')], additions: 36, deletions: 2, updatedAt: ago(320) }),
    pullRequest({ number: 107, title: 'chore(deps): bump ws from 8.21.2 to 8.21.3', headRefName: 'dependabot/npm_and_yarn/ws-8.21.3', state: 'merged', author: person('app/dependabot'), labels: [labels.deps], reviewDecision: 'approved', additions: 3, deletions: 3, updatedAt: ago(1500) }),
    pullRequest({ number: 105, title: 'feat(desktop): onboarding and status panel', headRefName: 'feat/desktop-panel', state: 'merged', labels: [labels.desktop, labels.enhancement], reviewDecision: 'approved', comments: 12, additions: 49614, deletions: 107, updatedAt: ago(4200) }),
    pullRequest({ number: 104, title: 'refactor(db): fold the JSON state into SQLite', headRefName: 'refactor/sqlite-state', state: 'merged', reviewDecision: 'approved', comments: 5, additions: 2900, deletions: 3100, updatedAt: ago(9000) }),
    pullRequest({ number: 84, title: 'chore/stack-probe-b', headRefName: 'chore/stack-probe-b', baseRefName: 'chore/stack-probe-a', state: 'closed', isDraft: true, reviewDecision: null, checks: [], comments: 1, additions: 1, deletions: 0, updatedAt: ago(5000) }),
    pullRequest({ number: 83, title: 'chore/stack-probe-a', headRefName: 'chore/stack-probe-a', state: 'closed', isDraft: true, reviewDecision: null, checks: [], comments: 1, additions: 1, deletions: 0, updatedAt: ago(5010) }),
]

const counted = <T extends { state: string }>(items: T[], states: string[]): Record<string, number> => ({
  ...Object.fromEntries(states.map((state) => [state, items.filter((item) => item.state === state).length])),
  all: items.length,
})

export const mockGithubPullRequests: GithubPullRequestList = {
  repository: githubRef,
  state: 'all',
  limit: 30,
  after: null,
  fetchedAt: ago(0),
  counts: counted(mockPullRequests, ['open', 'merged', 'closed']),
  totalCount: mockPullRequests.length,
  nextCursor: null,
  items: mockPullRequests.map(({ reviewDecision: _review, checks: _checks, additions: _additions, deletions: _deletions, ...item }) => item),
}

const issue = (fields: Partial<GithubIssue> & Pick<GithubIssue, 'number' | 'title'>): GithubIssue => ({
  state: 'open',
  author: person('operator', 'Operator'),
  labels: [],
  assignees: [],
  createdAt: ago(900),
  updatedAt: ago(120),
  url: `https://github.com/operator/megabrain/issues/${fields.number}`,
  comments: 0,
  milestone: null,
  ...fields,
})

const mockIssues: GithubIssue[] = [
    issue({ number: 118, title: 'tmux launch line is cut at 1024 bytes before the shell is ready', labels: [labels.bug], comments: 4, assignees: [person('operator', 'Operator')], milestone: { title: 'v0.3.0', dueOn: '2026-11-01T00:00:00Z' }, updatedAt: ago(12) }),
    issue({ number: 117, title: 'Desktop: open links from chats and GitHub pages in the browser', labels: [labels.desktop, labels.enhancement], comments: 1, updatedAt: ago(80) }),
    issue({ number: 116, title: 'doctor reports simulator-web healthy when Firefox is missing', labels: [labels.bug, labels.triage], author: person('fake-contributor', 'Fake Contributor'), updatedAt: ago(300) }),
    issue({ number: 115, title: 'Document the resource governor in the skill', labels: [labels.docs, labels.good], milestone: { title: 'v0.3.0', dueOn: '2026-11-01T00:00:00Z' }, updatedAt: ago(2000) }),
    issue({ number: 102, title: 'Supervisor misses a child whose pane died during compaction', state: 'closed', labels: [labels.bug], comments: 6, assignees: [person('operator', 'Operator')], updatedAt: ago(6000) }),
    issue({ number: 99, title: 'Ship the desktop app as a dmg', state: 'closed', labels: [labels.desktop], comments: 2, milestone: { title: 'v0.2.4', dueOn: null }, updatedAt: ago(9000) }),
]

export const mockGithubIssues: GithubIssueList = {
  repository: githubRef,
  state: 'all',
  limit: 30,
  after: null,
  fetchedAt: ago(0),
  counts: counted(mockIssues, ['open', 'closed']),
  totalCount: mockIssues.length,
  nextCursor: null,
  items: mockIssues,
}

/** One page of a mock listing, the way the CLI pages: the cursor is where the next page starts. */
export function mockPage<T extends { state: string }>(items: T[], state: string, limit: number, after: string | null) {
  const matching = items.filter((item) => state === 'all' || item.state === state)
  const start = after === null ? 0 : Number(after)
  const end = start + limit
  return { state, limit, after, totalCount: matching.length, nextCursor: end < matching.length ? String(end) : null, items: matching.slice(start, end), fetchedAt: ago(0) }
}

export const mockGithubDetail = (kind: 'pr' | 'issue', number: number): GithubDetail => {
  const pull = kind === 'pr' ? mockPullRequests.find((entry) => entry.number === number) : undefined
  const item = kind === 'pr' ? pull : mockIssues.find((entry) => entry.number === number)
  return {
    repository: githubRef,
    number,
    title: item?.title ?? `#${number}`,
    state: item?.state ?? 'open',
    ...(kind === 'pr' ? { isDraft: pull?.isDraft ?? false, reviewDecision: pull?.reviewDecision ?? null, checks: pull?.checks ?? [], additions: pull?.additions ?? 0, deletions: pull?.deletions ?? 0, headRefName: pull?.headRefName ?? 'feature', baseRefName: pull?.baseRefName ?? 'main' } : {}),
    url: item?.url ?? githubRef.url,
    author: item?.author ?? null,
    createdAt: item?.createdAt ?? null,
    body: [
      '## Summary',
      '',
      'Adds the **pull request** and **issue** pages, opened from the two icons on each project row.',
      '',
      '- Tabs with counts, search and filters',
      '- Light rows with labels in their GitHub colors; checks and review in the detail',
      '- A detail pane with the body and comments',
      '',
      '```ts',
      "api.githubPullRequests(root, 'open', 30, null)",
      '```',
      '',
      '| Check | State |',
      '| --- | --- |',
      '| typecheck | passing |',
      '| unit | pending |',
      '',
      '## Screenshots',
      '',
      '| Pages | Detail | Gone |',
      '| --- | --- | --- |',
      `| <img src="${githubRef.url}/blob/0a1b2c3/docs/pages.png?raw=true" width="120"> | <img src="${githubRef.url}/blob/0a1b2c3/docs/detail.png?raw=true" width="120"> | <img src="${githubRef.url}/blob/0a1b2c3/docs/missing.png?raw=true" alt="An old capture" width="120"> |`,
    ].join('\n'),
    comments:
      (item?.comments ?? 0) === 0
        ? []
        : [
            { author: person('fake-contributor', 'Fake Contributor'), body: 'Looks good. One question: does the cache key include the limit?', createdAt: ago(50), url: `${item?.url ?? ''}#issuecomment-1` },
            { author: person('operator', 'Operator'), body: 'It does — one entry per command, state, limit and number.', createdAt: ago(20), url: `${item?.url ?? ''}#issuecomment-2` },
          ],
  }
}

/** The files of a mock pull request: one edit, one new file, one rename, one removal and a binary. */
export const mockPullRequestFiles = (number: number): GithubPullRequestFile[] => [
  {
    path: 'apps/desktop/src/github/github-requests.ts',
    status: 'modified',
    additions: 4,
    deletions: 2,
    patch: [
      '@@ -1,9 +1,11 @@',
      " import { api } from '@/api'",
      "-import type { GithubIssueList, GithubPullRequestList } from '@/api/schema'",
      "+import type { GithubIssueList, GithubPullRequestFile, GithubPullRequestList } from '@/api/schema'",
      " import { listRequestKey, pageSize, shareInFlight } from '@/github/github-model'",
      ' ',
      '-const share = shareInFlight()',
      '+// One gh call per key while it runs.',
      '+const share = shareInFlight()',
      ' ',
      " export type PullRequestState = 'open' | 'closed' | 'merged' | 'all'",
      `+export const pullRequest = ${number}`,
      " export type IssueState = 'open' | 'closed' | 'all'",
      '@@ -14,5 +16,5 @@ export function pullRequestPage(root: string, state: PullRequestState, after: string | null)',
      ' ',
      ' export function issuePage(root: string, state: IssueState, after: string | null): Promise<GithubIssueList> {',
      '-  return share(listRequestKey(\'issues\', root, state, pageSize, after), () => api.githubIssues(root, state, pageSize, after))',
      '+  return share(listRequestKey(\'issues\', root, state, pageSize, after), () => api.githubIssues(root, state, pageSize, after)) // shared',
      ' }',
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/github/review-notes.md',
    status: 'added',
    additions: 5,
    deletions: 0,
    patch: ['@@ -0,0 +1,5 @@', '+# Review notes', '+', '+- Inline comments stay **pending** until the review is submitted.', '+- Merge asks first.', '+- Errors show gh\'s own message.'].join('\n'),
  },
  {
    path: 'src/cli/commands/github-review.ts',
    previousPath: 'src/cli/commands/review.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    patch: ['@@ -3,3 +3,3 @@ export async function review(args: string[]) {', '   const event = flag(args, "--event")', '-  return run("gh", ["pr", "review", ...args])', '+  return run("gh", ["pr", "review", "--json", ...args])', ' }'].join('\n'),
  },
  {
    path: 'docs/old-review.md',
    status: 'removed',
    additions: 0,
    deletions: 2,
    patch: ['@@ -1,2 +0,0 @@', '-# Old review', '-Superseded.'].join('\n'),
  },
  { path: 'apps/desktop/icons/review.png', status: 'modified', additions: 0, deletions: 0, patch: null },
]
