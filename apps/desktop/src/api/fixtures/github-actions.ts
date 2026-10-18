import type { DesktopApi } from '@/api/adapter'
import type { GithubActionRun, GithubActionRunDetail, GithubActionRuns } from '@/api/schema'

// The mock's GitHub Actions: four workflows and a few dozen runs across the mock repository's
// branches (one running, one failing on a pull request's branch), jobs and steps per run, readable
// logs, and run actions that change what the next read returns: a cancel ends a live run, a re-run
// queues a new attempt that starts a few seconds later and passes a little after that.

type Job = GithubActionRunDetail['jobs'][number]
type Step = Job['steps'][number]
type Workflow = GithubActionRuns['workflows'][number]

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const plus = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString()
const repository = 'https://github.com/operator/megabrain'

export const mockWorkflows: Workflow[] = [
  { id: 101, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', dispatchable: false, inputs: [] },
  { id: 102, name: 'Release', path: '.github/workflows/release.yml', state: 'active', dispatchable: true, inputs: [{ name: 'dry-run', description: 'Build and tag without publishing', required: false, type: 'boolean', default: true }] },
  { id: 103, name: 'Docs', path: '.github/workflows/docs.yml', state: 'active', dispatchable: false, inputs: [] },
  {
    id: 104,
    name: 'Nightly e2e',
    path: '.github/workflows/nightly.yml',
    state: 'active',
    dispatchable: true,
    inputs: [
      { name: 'suite', description: 'Which suite to run', required: true, type: 'string', default: 'smoke' },
      { name: 'browser', description: 'Browser engine', required: false, type: 'choice', default: 'chromium', options: ['chromium', 'webkit', 'both'] },
      { name: 'retries', description: 'Retries per failing test', required: false, type: 'number', default: 1 },
      { name: 'debug', description: 'Keep traces and videos', required: false, type: 'boolean', default: false },
    ],
  },
  { id: 105, name: 'Legacy deploy', path: '.github/workflows/deploy.yml', state: 'disabled_manually', dispatchable: true, inputs: [] },
]

const jobNames: Record<string, string[]> = {
  CI: ['typecheck', 'lint', 'unit', 'container (macos-15)'],
  Release: ['release-please', 'publish'],
  Docs: ['build', 'deploy'],
  'Nightly e2e': ['e2e (chromium)', 'e2e (webkit)'],
}

interface Seed {
  id: number
  name: string
  title: string
  branch: string
  event: string
  minutes: number
  /** Seconds it ran; null while it runs. */
  seconds: number | null
  conclusion?: GithubActionRun['conclusion']
  status?: GithubActionRun['status']
  prNumber?: number
  actor?: string
}

const seeds: Seed[] = [
  { id: 9021, name: 'CI', title: 'feat(desktop): pull request and issue pages', branch: 'feat/desktop-github-pages', event: 'pull_request', minutes: 3, seconds: null, status: 'in_progress', prNumber: 112 },
  { id: 9020, name: 'Docs', title: 'feat(desktop): pull request and issue pages', branch: 'feat/desktop-github-pages', event: 'pull_request', minutes: 3, seconds: null, status: 'queued', prNumber: 112 },
  { id: 9019, name: 'CI', title: 'fix(spawn): keep the launch line under the tmux limit', branch: 'fix/spawn-launch-line', event: 'pull_request', minutes: 34, seconds: 412, conclusion: 'failure', prNumber: 111 },
  { id: 9018, name: 'CI', title: 'merge: search, share, select, edit and branch in the chat', branch: 'main', event: 'push', minutes: 52, seconds: 388, conclusion: 'success' },
  { id: 9017, name: 'Release', title: 'merge: search, share, select, edit and branch in the chat', branch: 'main', event: 'push', minutes: 52, seconds: 74, conclusion: 'success' },
  { id: 9016, name: 'CI', title: 'polish(desktop): move setup and watcher into settings', branch: 'polish/desktop-settings', event: 'pull_request', minutes: 88, seconds: 371, conclusion: 'success', prNumber: 110, actor: 'fake-contributor' },
  { id: 9015, name: 'CI', title: 'feat(desktop): onboarding and status panel', branch: 'feat/desktop-panel', event: 'push', minutes: 140, seconds: 402, conclusion: 'success' },
  { id: 9014, name: 'CI', title: 'feat(desktop): columns in the status panel', branch: 'feat/desktop-panel-columns', event: 'push', minutes: 165, seconds: 95, conclusion: 'cancelled' },
  { id: 9013, name: 'CI', title: 'fix(queue): cancel only the owner’s items', branch: 'fix/queue-cancel-owner', event: 'push', minutes: 210, seconds: 3990, conclusion: 'timed_out' },
  { id: 9012, name: 'Docs', title: 'docs(readme): document the github commands', branch: 'docs/github-commands', event: 'pull_request', minutes: 318, seconds: 58, conclusion: 'success', prNumber: 108 },
  { id: 9011, name: 'Nightly e2e', title: 'Nightly e2e', branch: 'main', event: 'schedule', minutes: 610, seconds: 1544, conclusion: 'failure', actor: 'github-actions[bot]' },
  { id: 9010, name: 'Nightly e2e', title: 'Nightly e2e', branch: 'main', event: 'workflow_dispatch', minutes: 1290, seconds: 1501, conclusion: 'success' },
  { id: 9009, name: 'Release', title: 'chore(main): release 0.9.0', branch: 'main', event: 'push', minutes: 1480, seconds: 0, conclusion: 'skipped' },
  { id: 9008, name: 'CI', title: 'chore(deps): bump ws from 8.21.2 to 8.21.3', branch: 'dependabot/npm_and_yarn/ws-8.21.3', event: 'pull_request', minutes: 1500, seconds: 352, conclusion: 'success', prNumber: 107, actor: 'dependabot[bot]' },
]

// An older history on main so the list pages: every third one failed, the rest passed.
const history: Seed[] = Array.from({ length: 36 }, (_, index) => ({
  id: 8990 - index,
  name: index % 4 === 3 ? 'Docs' : 'CI',
  title: [`refactor(db): fold the JSON state into SQLite`, `fix(chat): ignore incomplete rewind events`, `polish(sidebar): quieter usage meters`, `feat(cli): github threads and replies`][index % 4] ?? '',
  branch: 'main',
  event: 'push',
  minutes: 1600 + index * 190,
  seconds: 300 + ((index * 37) % 140),
  conclusion: index % 3 === 2 ? 'failure' : 'success',
}))

const counters = new Map<string, number>()
function runOf(seed: Seed): GithubActionRun {
  const workflowRuns = (counters.get(seed.name) ?? 600) + 1
  counters.set(seed.name, workflowRuns)
  const createdAt = minutesAgo(seed.minutes)
  const startedAt = plus(createdAt, 4)
  return {
    id: seed.id,
    name: seed.name,
    title: seed.title,
    event: seed.event,
    branch: seed.branch,
    sha: (seed.id * 2654435761).toString(16).padStart(8, '0').slice(-7) + 'e41c2a9b0d3f5a7c6e8b1d2f4a6c8e0b2d4f6a8c',
    status: seed.status ?? 'completed',
    conclusion: seed.seconds === null ? null : (seed.conclusion ?? 'success'),
    number: 2000 - (seed.id % 1000) + workflowRuns,
    attempt: 1,
    actor: seed.actor ?? 'operator',
    createdAt,
    updatedAt: seed.seconds === null ? plus(startedAt, 20) : plus(startedAt, seed.seconds),
    startedAt: seed.status === 'queued' ? null : startedAt,
    url: `${repository}/actions/runs/${seed.id}`,
    prNumber: seed.prNumber ?? null,
  }
}

const baseRuns = [...seeds, ...history].map(runOf)

const stepNames = (job: string) => ['Set up job', 'Checkout', 'Set up Bun', 'Install dependencies', job.startsWith('container') ? 'Run container suite' : job === 'unit' ? 'Run unit tests' : `Run ${job.replace(/ \(.*\)$/, '')}`, 'Post Checkout', 'Complete job']

/** Steps across a job's time: all passed, or the one that ran the job failed while setup and cleanup passed. */
function stepsOf(job: string, startedAt: string | null, seconds: number, outcome: 'success' | 'failure' | 'cancelled' | 'running' | 'queued'): Step[] {
  const names = stepNames(job)
  const failing = names.findIndex((name) => name.startsWith('Run '))
  const share = [2, 3, 6, 14, 70, 2, 3]
  let at = startedAt === null ? null : Date.parse(startedAt)
  return names.map((name, index) => {
    const length = Math.max(1, Math.round((seconds * (share[index] ?? 1)) / 100))
    const start = at === null ? null : new Date(at).toISOString()
    const done = outcome === 'running' ? index < failing : outcome !== 'queued'
    const end = done && at !== null ? new Date((at += length * 1000)).toISOString() : null
    const running = outcome === 'running' && index === failing
    const conclusion = !done ? null : outcome === 'success' || index !== failing ? 'success' : outcome === 'cancelled' ? 'cancelled' : 'failure'
    return { number: index + 1, name, status: running ? 'in_progress' : done ? 'completed' : 'queued', conclusion, startedAt: running || done ? start : null, completedAt: end }
  })
}

function jobsOf(run: GithubActionRun): Job[] {
  const names = jobNames[run.name] ?? ['build']
  const total = run.startedAt === null ? 0 : (Date.parse(run.updatedAt) - Date.parse(run.startedAt)) / 1000
  return names.map((name, index): Job => {
    const id = run.id * 10 + index
    const url = `${run.url}/job/${id}`
    const startedAt = run.startedAt === null ? null : plus(run.startedAt, index * 3)
    const seconds = Math.max(8, Math.round(total * ([0.35, 0.3, 0.8, 0.95][index % 4] ?? 1)))
    if (run.status === 'queued' || run.status === 'pending' || run.status === 'requested') return { id, name, status: 'queued', conclusion: null, startedAt: null, completedAt: null, url, steps: stepsOf(name, null, 0, 'queued') }
    if (run.status === 'in_progress') {
      if (index < 2) return { id, name, status: 'completed', conclusion: 'success', startedAt, completedAt: startedAt === null ? null : plus(startedAt, 30 + index * 12), url, steps: stepsOf(name, startedAt, 30 + index * 12, 'success') }
      if (index === 2) return { id, name, status: 'in_progress', conclusion: null, startedAt, completedAt: null, url, steps: stepsOf(name, startedAt, 120, 'running') }
      return { id, name, status: 'queued', conclusion: null, startedAt: null, completedAt: null, url, steps: stepsOf(name, null, 0, 'queued') }
    }
    const failedHere = (run.conclusion === 'failure' || run.conclusion === 'timed_out') && index === (run.name === 'CI' ? 2 : 0)
    const cancelled = run.conclusion === 'cancelled' && index >= 1
    const skipped = run.conclusion === 'skipped'
    const conclusion = skipped ? 'skipped' : failedHere ? (run.conclusion === 'timed_out' ? 'timed_out' : 'failure') : cancelled ? 'cancelled' : 'success'
    const end = startedAt === null ? null : plus(startedAt, skipped ? 0 : seconds)
    return { id, name, status: 'completed', conclusion, startedAt, completedAt: end, url, steps: skipped ? [] : stepsOf(name, startedAt, seconds, failedHere ? 'failure' : cancelled ? 'cancelled' : 'success') }
  })
}

const stamp = (iso: string, second: number) => `${plus(iso, second).replace('Z', '0000Z')} `

function setupLines(): string[] {
  return [
    '##[group]Runner Image',
    'Image: macos-15-arm64',
    'Version: 20261012.1',
    '##[endgroup]',
    '##[group]Run actions/checkout@v5',
    'with:',
    '  repository: operator/megabrain',
    '  fetch-depth: 1',
    '##[endgroup]',
    '[command]/opt/homebrew/bin/git version',
    'git version 2.51.0',
    '[command]/opt/homebrew/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +refs/heads/main',
    'From https://github.com/operator/megabrain',
    ' * [new ref]         e41c2a9b0d3f5a7c6e8b1d2f4a6c8e0b2d4f6a8c -> origin/main',
    '##[group]Run oven-sh/setup-bun@v2',
    'Downloading a new version of Bun: https://bun.sh/download/1.3.14/darwin/aarch64',
    '##[endgroup]',
    '##[group]Run bun install --frozen-lockfile',
    '\u001b[36mbun install\u001b[0m v1.3.14 (0d9b296a)',
    'Resolving dependencies',
    'Resolved, downloaded and extracted [1204]',
    '\u001b[32m+\u001b[0m 1204 packages installed [4.21s]',
    '##[endgroup]',
  ]
}

function failingLines(): string[] {
  const passing = Array.from({ length: 140 }, (_, index) => `\u001b[32m(pass)\u001b[0m ${['spawn', 'queue', 'chain', 'worktree', 'notify'][index % 5]} > ${['keeps the brief whole', 'records the dispatch', 'reports the owner', 'refuses an unknown flag', 'acks twice safely', 'opens a viewer'][index % 6]} [${(index * 7) % 40}.${index % 10}0ms]`)
  return [
    '##[group]Run bun test tests/unit',
    'bun test tests/unit',
    'shell: /bin/bash -e {0}',
    '##[endgroup]',
    'bun test v1.3.14 (0d9b296a)',
    '',
    'tests/unit/spawn.test.ts:',
    ...passing.slice(0, 70),
    '',
    '\u001b[31m(fail)\u001b[0m spawn > keeps the launch line under the tmux limit [12.40ms]',
    '',
    '  error: expect(received).toBeLessThanOrEqual(expected)',
    '',
    '  Expected: <= 12000',
    '  Received: 12417',
    '',
    '      at <anonymous> (tests/unit/spawn.test.ts:318:42)',
    '',
    ...passing.slice(70),
    '',
    ' 214 pass',
    ' 1 fail',
    ' 902 expect() calls',
    'Ran 215 tests across 38 files. [8.41s]',
    '##[error]Process completed with exit code 1.',
  ]
}

function passingLines(job: string): string[] {
  return [
    `##[group]Run ${job}`,
    `bun run ${job}`,
    '##[endgroup]',
    ...Array.from({ length: 24 }, (_, index) => `[${job}] ${['checked', 'built', 'linked', 'verified'][index % 4]} ${['src/cli', 'src/core', 'apps/desktop/src', 'tests/unit'][index % 4]}/${index}.ts`),
    '##[warning]The macos-14 label will be removed on 2026-12-01; use macos-15.',
    `${job} finished without errors`,
  ]
}

function logOf(run: GithubActionRun, job: Job): { log: string; truncated: boolean } {
  const at = job.startedAt ?? run.createdAt
  const failed = job.conclusion === 'failure' || job.conclusion === 'timed_out'
  const lines = [...setupLines(), ...(failed ? failingLines() : passingLines(job.name))]
  // The container suite's log is long enough that the CLI cuts it.
  const truncated = job.name.startsWith('container') && !failed
  return { log: `${lines.map((line, index) => `${stamp(at, index)}${line}`).join('\n')}\n`, truncated }
}

/** The mock's `github runs|run|run-log|run-action|workflow-dispatch`, with the effects of its actions. */
export function createMockActionsApi(): Pick<DesktopApi, 'githubActionRuns' | 'githubActionRun' | 'githubActionRunLog' | 'githubActionRunAction' | 'githubWorkflowDispatch'> {
  const changed = new Map<number, { patch: Partial<GithubActionRun>; at: number }>()
  const dispatched: GithubActionRun[] = []

  /** A re-run or a dispatch: queued at first, running after 6 s, passed after 30 s. */
  const progressed = (run: GithubActionRun, since: number): GithubActionRun => {
    const age = Date.now() - since
    const startedAt = new Date(since + 6000).toISOString()
    if (age < 6000) return { ...run, status: 'queued', conclusion: null, startedAt: null, updatedAt: new Date(since).toISOString() }
    if (age < 30_000) return { ...run, status: 'in_progress', conclusion: null, startedAt, updatedAt: new Date().toISOString() }
    return { ...run, status: 'completed', conclusion: 'success', startedAt, updatedAt: new Date(since + 30_000).toISOString() }
  }
  const current = (): GithubActionRun[] =>
    [...dispatched, ...baseRuns].map((run) => {
      const change = changed.get(run.id)
      if (change === undefined) return dispatched.includes(run) ? progressed(run, Date.parse(run.createdAt)) : run
      const patched = { ...run, ...change.patch }
      return change.patch.status === 'queued' ? progressed(patched, change.at) : patched
    })
  const find = (runId: number) => {
    const run = current().find((entry) => entry.id === runId)
    if (run === undefined) throw new Error(`gh: Not Found (HTTP 404): run ${runId}`)
    return run
  }

  return {
    githubActionRuns: async (_root, options = {}) => {
      await wait(380)
      const workflow = mockWorkflows.find((entry) => entry.name === options.workflow || String(entry.id) === options.workflow)
      const runs = current().filter(
        (run) =>
          (options.branch === undefined || run.branch === options.branch) &&
          (options.workflow === undefined || run.name === (workflow?.name ?? options.workflow)) &&
          (options.status === undefined || run.status === options.status || run.conclusion === options.status),
      )
      const start = options.after === undefined || options.after === null ? 0 : Number(options.after)
      const limit = options.limit ?? 30
      return { runs: runs.slice(start, start + limit), workflows: mockWorkflows, next: start + limit < runs.length ? String(start + limit) : null }
    },
    githubActionRun: async (_root, runId) => {
      await wait(300)
      const run = find(runId)
      return { ...run, jobs: jobsOf(run) }
    },
    githubActionRunLog: async (_root, runId, jobId) => {
      await wait(450)
      const run = find(runId)
      const job = jobsOf(run).find((entry) => entry.id === jobId)
      if (job === undefined) throw new Error(`gh: Not Found (HTTP 404): job ${jobId}`)
      return logOf(run, job)
    },
    githubActionRunAction: async (_root, runId, action) => {
      await wait(500)
      const run = find(runId)
      if (action === 'cancel') {
        if (run.status === 'completed') throw new Error('gh: Cannot cancel a workflow run that is completed. (HTTP 409)')
        changed.set(runId, { patch: { status: 'completed', conclusion: 'cancelled', updatedAt: new Date().toISOString() }, at: Date.now() })
        return
      }
      if (run.status !== 'completed') throw new Error('gh: This workflow is already running (HTTP 403)')
      changed.set(runId, { patch: { status: 'queued', attempt: run.attempt + 1 }, at: Date.now() })
    },
    githubWorkflowDispatch: async (_root, workflow, ref) => {
      await wait(600)
      const known = mockWorkflows.find((entry) => entry.name === workflow || String(entry.id) === workflow || entry.path.endsWith(`/${workflow}`))
      if (known === undefined || !known.dispatchable || known.state !== 'active') throw new Error(`gh: Workflow does not have 'workflow_dispatch' trigger (HTTP 422)`)
      const id = 9100 + dispatched.length
      dispatched.unshift({ ...runOf({ id, name: known.name, title: known.name, branch: ref, event: 'workflow_dispatch', minutes: 0, seconds: null, status: 'queued' }), createdAt: new Date().toISOString() })
    },
  }
}
