import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mockSettings, mockGithubDetail, mockPullRequestFiles, mockGithubIssues, mockGithubPullRequests, mockGithubRepositories, mockGithubOwners, mockDiscovered, mockProjects, mockChatRead, mockBranchChanges, mockCodeChanges, mockCodeDiff, mockCodeTree, mockDoctor, mockInstallPlan, mockInstallRun, mockStatus, mockTranscript, mockWorktrees } from '@/api/fixtures/mock'
import { agentDefaultsSchema, settingsSchema, githubDetailSchema, githubPullRequestFileSchema, githubIssueListSchema, githubPullRequestListSchema, githubRepositorySchema, githubOwnerSchema, discoveredRepositorySchema, projectsSchema, branchChangesSchema, chatReadSchema, codeChangeSchema, codeDiffSchema, codeEntrySchema, doctorReportSchema, transcriptSchema, installEventSchema, installPlanSchema, moduleResultSchema, replyResultSchema, statusSchema, worktreeListSchema, knowledgeListSchema, knowledgeSearchSchema, knowledgeTopicSchema, knowledgeTranscriptSchema, artifactContentSchema } from '@/api/schema'
import { openProject } from '../../../../src/knowledge/store'

const captured = join(import.meta.dir, 'fixtures', 'captured')
const json = (name: string): unknown => JSON.parse(readFileSync(join(captured, name), 'utf8'))
const lines = (name: string): unknown[] =>
  readFileSync(join(captured, name), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))

describe('captured CLI payloads parse with the schemas', () => {
  test('install --plan --json', () => {
    expect(installPlanSchema.safeParse(json('install-plan.json')).success).toBe(true)
  })
  test('status --json', () => {
    const parsed = statusSchema.safeParse(json('status.json'))
    expect(parsed.error).toBeUndefined()
    expect(parsed.data?.dispatches.length).toBeGreaterThan(0)
  })
  test('doctor --json', () => {
    expect(doctorReportSchema.safeParse(json('doctor.json')).error).toBeUndefined()
  })
  test('worktree list --json', () => {
    const parsed = worktreeListSchema.safeParse(json('worktree-list.json'))
    expect(parsed.error).toBeUndefined()
    expect(parsed.data?.every((entry) => entry.repository !== undefined)).toBe(true)
  })
  test('orchestrate read --json and reply --json', () => {
    expect(chatReadSchema.safeParse({ dispatchId: 'dispatch-1', pane: '%3', source: 'tmux', truncated: false, text: 'hello' }).success).toBe(true)
    expect(replyResultSchema.safeParse({ dispatchId: 'dispatch-1', status: 'queued', nudge: 'typed', supersededQueued: 0, supersededDelivered: 0, deliveredSequences: [] }).success).toBe(true)
  })
  test('github prs|issues --json', () => {
    const prs = githubPullRequestListSchema.safeParse(json('github-prs.json'))
    expect(prs.error).toBeUndefined()
    expect(prs.data?.items.length).toBeGreaterThan(0)
    const issues = githubIssueListSchema.safeParse(json('github-issues.json'))
    expect(issues.error).toBeUndefined()
    expect(issues.data?.items.length).toBeGreaterThan(0)
  })
  test('the GitHub mock data matches the schemas', () => {
    expect(githubPullRequestListSchema.safeParse(mockGithubPullRequests).error).toBeUndefined()
    expect(githubIssueListSchema.safeParse(mockGithubIssues).error).toBeUndefined()
    expect(githubDetailSchema.safeParse(mockGithubDetail('pr', 112)).error).toBeUndefined()
    expect(githubDetailSchema.safeParse(mockGithubDetail('issue', 118)).error).toBeUndefined()
    expect(githubPullRequestFileSchema.array().safeParse(mockPullRequestFiles(112)).error).toBeUndefined()
  })
  test('install --json events', () => {
    const events = lines('install-failed.ndjson')
    expect(events.map((event) => installEventSchema.safeParse(event).success)).toEqual(events.map(() => true))
  })
})

describe('the mock serves payloads the schemas accept', () => {
  test('plan, status and doctor', () => {
    expect(installPlanSchema.safeParse(mockInstallPlan).error).toBeUndefined()
    expect(statusSchema.safeParse(mockStatus).error).toBeUndefined()
    expect(doctorReportSchema.safeParse(mockDoctor).error).toBeUndefined()
    expect(worktreeListSchema.safeParse(mockWorktrees).error).toBeUndefined()
    expect(chatReadSchema.safeParse(mockChatRead).error).toBeUndefined()
  })
  test('settings', () => {
    expect(settingsSchema.safeParse(mockSettings).error).toBeUndefined()
  })
  test('projects', () => {
    expect(projectsSchema.safeParse(mockProjects).error).toBeUndefined()
    expect(githubRepositorySchema.array().safeParse(mockGithubRepositories).error).toBeUndefined()
    expect(githubOwnerSchema.array().safeParse(mockGithubOwners).error).toBeUndefined()
    expect(discoveredRepositorySchema.array().safeParse(mockDiscovered).error).toBeUndefined()
  })
  test('transcript and code', () => {
    expect(transcriptSchema.safeParse(mockTranscript).error).toBeUndefined()
    expect(new Set(mockTranscript.events.map((event) => event.kind)).size).toBe(6)
    expect(codeEntrySchema.array().safeParse(mockCodeTree).error).toBeUndefined()
    expect(codeChangeSchema.array().safeParse(mockCodeChanges).error).toBeUndefined()
    expect(codeDiffSchema.safeParse(mockCodeDiff).error).toBeUndefined()
    expect(branchChangesSchema.safeParse(mockBranchChanges).error).toBeUndefined()
  })
  test('the install run covers every event type and ends in one result', () => {
    for (const event of mockInstallRun) expect(installEventSchema.safeParse(event).error).toBeUndefined()
    const types = new Set(mockInstallRun.map((event) => event.type))
    expect([...types].sort()).toEqual(['confirm', 'info', 'intro', 'result', 'step', 'warn'])
    expect(mockInstallRun.filter((event) => event.type === 'result')).toHaveLength(1)
    expect(mockInstallRun.at(-1)?.type).toBe('result')
  })
  test('the mock status has a finding with a recommendation and a queued item', () => {
    expect(mockStatus.dispatches.some((item) => item.supervision.finding?.recommendation !== undefined)).toBe(true)
    expect(mockStatus.queue.length).toBeGreaterThan(0)
  })
})

describe('module results', () => {
  test('install <module> --json', () => {
    expect(moduleResultSchema.safeParse({ module: 'worktree', action: 'install', ok: false, message: 'Shared worktrees: missing' }).success).toBe(true)
    expect(moduleResultSchema.safeParse({ module: 'worktree', ok: false }).success).toBe(false)
  })
})

// The staged sidecar is the CLI the app ships. Run it against throwaway state and HOME so a change in
// its JSON shows up here instead of as a blank panel. Stage it with `bun run stage-cli`.
describe('the staged CLI still speaks the schemas', () => {
  const binaries = join(import.meta.dir, '..', '..', 'src-tauri', 'binaries')
  const triple = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout.match(/^host: (.+)$/m)?.[1] ?? ''
  const cli = join(binaries, `megabrain-cli-${triple}`)

  const run = (args: string[]): { code: number | null; stdout: string } => {
    const home = mkdtempSync(join(tmpdir(), 'megabrain-desktop-home-'))
    const state = mkdtempSync(join(tmpdir(), 'megabrain-desktop-state-'))
    try {
      const result = spawnSync(cli, args, {
        cwd: home,
        encoding: 'utf8',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          MEGABRAIN_STATE_DIR: state,
          MEGABRAIN_ROOT: join(binaries, 'share', 'megabrain'),
          // Never the operator's tmux server.
          MEGABRAIN_TMUX_SOCKET: join(state, 'tmux.sock'),
          TMUX_TMPDIR: state,
        },
      })
      return { code: result.status, stdout: result.stdout }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    }
  }

  test('knowledge show, list, search and transcript match app schemas', () => {
    const home = mkdtempSync(join(tmpdir(), 'megabrain-desktop-home-'))
    const state = mkdtempSync(join(tmpdir(), 'megabrain-desktop-state-'))
    try {
      const repo = '/tmp/knowledge-contract-project'
      const project = openProject(state, repo)
      project.saveTopic({ id: 'diagnostico-rede-local', project: repo, title: 'Diagnóstico de rede local', kind: 'investigation', status: 'active', createdAt: '2026-10-17T10:00:00.000Z', updatedAt: '2026-10-17T10:00:00.000Z', aliases: [], sections: { overview: 'Diagnóstico do Shizuku.', state: 'Verificado.', pitfalls: '', open: '' }, decisions: [], refs: [], chats: ['c1'], keyMessages: [] })
      project.saveChat({ id: 'c1', sessionKeys: ['chat:c1'], title: null, summary: 'Diagnóstico do Shizuku', agent: 'claude', model: null, branch: '', worktree: repo, startedAt: '2026-10-17T10:00:00.000Z', endedAt: '', topics: ['diagnostico-rede-local'], refs: [], userTurns: 1, summarizedAt: '2026-10-17T10:00:00.000Z', curated: true })
      project.writeTranscript('c1', [{ cursor: '1', at: '2026-10-17T10:00:00.000Z', role: 'person', text: 'Diagnóstico local' }])
      const invoke = (args: string[]) => spawnSync(cli, args, { cwd: home, encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MEGABRAIN_STATE_DIR: state, MEGABRAIN_ROOT: join(binaries, 'share', 'megabrain'), MEGABRAIN_TMUX_SOCKET: join(state, 'tmux.sock'), TMUX_TMPDIR: state } })
      const show = invoke(['knowledge', 'show', 'diagnostico-rede-local', '--json'])
      const list = invoke(['knowledge', 'list', '--json'])
      const search = invoke(['knowledge', 'search', 'diagnóstico', '--json'])
      const transcript = invoke(['knowledge', 'transcript', 'c1', '--json'])
      expect(show.status).toBe(0)
      expect(knowledgeTopicSchema.safeParse(JSON.parse(show.stdout)).error).toBeUndefined()
      expect(list.status).toBe(0)
      expect(knowledgeListSchema.safeParse(JSON.parse(list.stdout)).error).toBeUndefined()
      expect(search.status).toBe(0)
      expect(knowledgeSearchSchema.safeParse(JSON.parse(search.stdout)).error).toBeUndefined()
      expect(transcript.status).toBe(0)
      expect(knowledgeTranscriptSchema.safeParse(JSON.parse(transcript.stdout)).error).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    }
  })

  test('the sidecar is staged', () => {
    expect(existsSync(cli)).toBe(true)
  })
  test('install --plan --json', () => {
    const result = run(['install', '--plan', '--json'])
    expect(result.code).toBe(0)
    expect(installPlanSchema.safeParse(JSON.parse(result.stdout)).error).toBeUndefined()
  })
  test('status --json', () => {
    const result = run(['status', '--json'])
    expect(result.code).toBe(0)
    expect(statusSchema.safeParse(JSON.parse(result.stdout)).error).toBeUndefined()
  })
  test('agent defaults --json', () => {
    const result = run(['agent', 'defaults', '--json'])
    expect(result.code).toBe(0)
    expect(agentDefaultsSchema.safeParse(JSON.parse(result.stdout)).error).toBeUndefined()
  })
  test('doctor --json', () => {
    const result = run(['doctor', '--json'])
    expect(doctorReportSchema.safeParse(JSON.parse(result.stdout)).error).toBeUndefined()
  })
})

describe('artifact show --json', () => {
  const shown = { id: 'art-1', title: 'Plan v3', kind: 'plan', format: 'markdown', project: '/work/api', projectName: 'api', projectId: 'api-0123456789ab', topics: [], chatId: null, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-17T12:00:00.000Z', revision: 3, path: '/state/knowledge/api-0123456789ab/artifacts/art-1/doc.md', content: '# Plan' }

  test('reads the versions its updates replaced', () => {
    const revisions = [{ revision: 1, title: 'Plan v1', updatedAt: '2026-10-15T10:00:00.000Z', replacedAt: '2026-10-16T10:00:00.000Z' }]
    expect(artifactContentSchema.parse({ ...shown, revisions }).revisions).toEqual(revisions)
  })

  test('an older megabrain that lists none still parses', () => {
    expect(artifactContentSchema.parse(shown).revisions).toBeUndefined()
  })
})
