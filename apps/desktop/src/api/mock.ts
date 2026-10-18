import { answerMockApproval, changeMockQueue, editLastMockChat, followMockChat, forkMockChat, interruptMockChat, mockCodexChat, mockCutChat, mockLongChat, mockNativeChat, publishMockArtifacts, readMockChat, sendMockChat, setMockChatMode, takeOverMockChat } from '@/api/fixtures/chat'
import { mockChatArtifact, mockChatArtifacts, touchMockChatArtifact } from '@/api/fixtures/chat-artifacts'
import { CliError, type DesktopApi, type PathLink } from '@/api/adapter'
import { sessionsOfOrigin } from '@/api/projects-origin'
import type { AgentUpdateEntry, ArchivedWorktree, CodeChange, GithubDetail, Project, ProjectAppearance, ProjectScripts, Chain, ChainStep } from '@/api/schema'
import { mockSettings, mockGithubDetail, mockGithubIssues, mockGithubPullRequests, mockGithubRepositories, mockGithubOwners, mockDiscovered, mockPage, mockImported, mockProjects, mockChatRead, mockBranchChanges, mockCodeChanges, mockCodeDiff, mockCodeFiles, mockNewFileDiff, mockCodeTree, mockDoctor, mockInstallPlan, mockInstallRun, mockStatus, mockTranscript, mockWorktrees, mockDispatchReport, mockSessionHistory } from '@/api/fixtures/mock'
import { explainChains } from '@/api/fixtures/chain-explain'
import { createMockMaestroApi } from '@/api/fixtures/maestro'
import { mockUsageStats } from '@/api/fixtures/usage'
import { mockKnowledgeList, mockKnowledgeSearch, mockKnowledgeTopics, mockKnowledgeTranscript } from '@/api/fixtures/knowledge'
import { mockArtifact, mockArtifactList } from '@/api/fixtures/artifacts'
import { createMockReviewApi } from '@/api/fixtures/github-review'
import { validateRule } from '@/settings/chain-rules'
import { effectiveToggles, inEffect, parseKnowledgeSettings } from '@/settings/knowledge-model'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A file the change list shows as new, whose diff has nothing on the original side. */
const isNew = (changes: readonly CodeChange[], path: string) => changes.some((change) => change.path === path && (change.status === 'added' || change.status === 'untracked'))

// Runs the UI in a plain browser (`bun run dev`) with fixed data and believable timing.
export function createMockApi(): DesktopApi {
  let link: PathLink = {
    linkPath: '/Users/operator/.local/bin/megabrain',
    kind: 'other-link',
    pointsTo: '/Users/operator/Workspaces/megabrain/.build/megabrain',
    bundled: '/Applications/megabrain.app/Contents/MacOS/megabrain-cli',
    dirOnPath: true,
    resolvesTo: '/Users/operator/Workspaces/megabrain/.build/megabrain',
  }
  let settings = mockSettings
  let sidebarFolders: unknown = { version: 1, folders: [], order: [] }
  let sidebarState: unknown = { version: 1, collapsed: [], rows: {} }
  let shortcuts: unknown = { version: 1, bindings: {} }
  let usageOrder: unknown = { version: 1, order: [], hidden: [] }
  let chatSummaries: unknown = { enabled: true, agent: 'claude', model: 'claude-haiku-5-5', effort: null, everyMessages: 6, everyMinutes: 10, retitle: true }
  let knowledgeSettings: unknown = { defaults: { summaries: true, retitle: true, topics: true, sessions: true, context: true }, projects: { '/Users/operator/Workspaces/local/stack': { summaries: false } } }
  let agentSettings: unknown = { version: 1, default: null, disabled: [] }
  let agentUpdateSettings: unknown = { enabled: true, perAgent: {} }
  // One agent in each state: Codex current, Claude behind, Grok's last update failed, agy's latest unknown.
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  let agentUpdates: AgentUpdateEntry[] = [
    { agent: 'claude', installed: '2.4.1', latest: '2.5.0', status: 'update-available', installKind: 'native', checkedAt: hoursAgo(2) },
    { agent: 'codex', installed: '0.163.0', latest: '0.163.0', status: 'up-to-date', installKind: 'standalone', checkedAt: hoursAgo(1) },
    { agent: 'grok', installed: '1.2.0', latest: '1.3.0', status: 'update-available', installKind: 'npm', checkedAt: hoursAgo(4), lastAttempt: { at: hoursAgo(4), ok: false, error: 'npm warn deprecated inflight@1.0.6\nnpm error path /usr/local/lib/node_modules/@xai/grok\nnpm error EACCES: permission denied, mkdir \'/usr/local/lib/node_modules/@xai\'' } },
    { agent: 'agy', installed: '1.4.1', latest: null, status: 'latest-unknown', installKind: 'unknown', checkedAt: hoursAgo(3) },
  ]
  let modelSettings: unknown = { version: 1, models: {}, defaults: {} }
  let worktreeLocation: unknown = null
  // What the GitHub writes changed: added comments and new states, by kind and number.
  const githubComments = new Map<string, GithubDetail['comments']>()
  const githubStates = new Map<string, string>()
  // Files, threads, reviewers and readiness (fixtures/github-review); a draft change shows in the detail.
  const { draftOf, ...reviewApi } = createMockReviewApi()
  const githubComment = (kind: 'pr' | 'issue', number: number, body: string) => {
    const key = `${kind}:${number}`
    const added = { author: { login: 'operator', name: 'Operator', isBot: false }, body, createdAt: new Date().toISOString(), url: `https://github.com/operator/megabrain/issues/${number}#mock-${Date.now()}` }
    githubComments.set(key, [...(githubComments.get(key) ?? []), added])
  }
  const githubEdited = (kind: 'pr' | 'issue', detail: GithubDetail): GithubDetail => {
    const key = `${kind}:${detail.number}`
    const draft = kind === 'pr' ? draftOf(detail.number) : undefined
    return { ...detail, state: githubStates.get(key) ?? detail.state, ...(draft === undefined ? {} : { isDraft: draft }), comments: [...detail.comments, ...(githubComments.get(key) ?? [])] }
  }
  // Sessions released from megabrain's tmux server (`session release`), and ones taken over (`session own`).
  const released = new Set<string>()
  const taken = new Set<string>()
  const withOwnership = (projects: Project[]): Project[] =>
    projects.map((project) => ({
      ...project,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        sessions: worktree.sessions.map((session) =>
          released.has(session.sessionId)
            ? { ...session, owner: 'external' as const, tmuxServer: null, tmuxSession: null }
            : taken.has(session.sessionId)
              ? { ...session, owner: 'megabrain' as const, tmuxServer: 'megabrain-app', tmuxSession: session.sessionId.replace(':', '-') }
              : session,
        ),
      })),
    }))
  const ownedSession = (sessionId: string) =>
    withOwnership(mockProjects).some((project) => project.worktrees.some((worktree) => worktree.sessions.some((session) => session.sessionId === sessionId && session.owner === 'megabrain')))
  // Saved commands per repository; anything unsaved falls back to what a package.json would give.
  const savedScripts = new Map<string, Partial<Record<'run' | 'build' | 'install', string>>>()
  const detectedScripts = { run: 'bun run dev', build: 'bun run build', install: null }
  const scriptsFor = (root: string): ProjectScripts => {
    const repo = mockProjects.find((project) => project.path === root || project.worktrees.some((worktree) => worktree.path === root))?.path ?? root
    const saved = savedScripts.get(repo) ?? {}
    const pick = (name: 'run' | 'build' | 'install') => {
      const command = saved[name]
      if (command !== undefined) return { command, source: 'saved' as const }
      const detected = detectedScripts[name]
      return detected === null ? null : { command: detected, source: 'detected' as const }
    }
    return { repo, scripts: { run: pick('run'), build: pick('build'), install: pick('install') } }
  }
  // Display names, colours and pictures by repository path, and the branches archived since launch.
  const appearances: Record<string, ProjectAppearance> = { [mockProjects[1]?.path ?? '']: { name: 'Canto', color: '#e11d48' } }
  let archived: ArchivedWorktree[] = []
  const archivedPaths = new Map<string, string>()
  const listed = (): Project[] =>
    withOwnership(mockProjects).map((project) => ({
      ...project,
      ...(appearances[project.path] === undefined ? {} : { appearance: appearances[project.path] }),
      worktrees: project.worktrees.filter((worktree) => !archived.some((entry) => entry.repo === project.path && entry.branch === worktree.branch && archivedPaths.get(`${entry.repo}:${entry.branch}`) === worktree.path)),
    }))
  return {
    kind: 'mock',
    status: async () => {
      await wait(120)
      return { ...mockStatus, generatedAt: new Date().toISOString() }
    },
    installPlan: async () => {
      await wait(300)
      return mockInstallPlan
    },
    doctor: async () => {
      await wait(600)
      return mockDoctor
    },
    async install(_args, onEvent) {
      for (const event of mockInstallRun) {
        await wait(event.type === 'step' && event.state === 'start' ? 700 : 150)
        onEvent(event)
      }
      return { code: 1, stderr: '' }
    },
    installModule: async (args) => {
      await wait(900)
      return { module: args[1] ?? '', action: 'install', ok: true, message: `${args[1]} is set up` }
    },
    pathLink: async () => link,
    linkCli: async (replace) => {
      if (link.kind === 'other-link' && !replace) throw new Error(`${link.linkPath} already points to ${link.pointsTo}; choose to replace it`)
      link = { ...link, kind: 'ours', pointsTo: link.bundled, resolvesTo: link.bundled }
      return link
    },
    setTraySummary: async () => {},
    windowVisible: async () => document.visibilityState === 'visible',
    worktrees: async () => mockWorktrees,
    readChat: async (dispatchId) => ({ ...mockChatRead, dispatchId }),
    reply: async (dispatchId) => {
      await wait(300)
      return { dispatchId, status: 'queued', nudge: 'typed' }
    },
    readDispatchMessage: async () => {
      await wait(200)
      return mockDispatchReport
    },
    transcript: async (target) => ({ ...mockTranscript, dispatchId: 'dispatchId' in target ? target.dispatchId : null, sessionId: 'sessionId' in target ? target.sessionId : mockTranscript.sessionId }),
    setHidden: async () => {},
    removeProject: async () => {},
    removeWorktree: async () => {},
    stackShow: async (repo, branch) => {
      await wait(400)
      const worktrees = mockProjects.find((project) => project.path === repo)?.worktrees ?? []
      const byBranch = new Map(worktrees.flatMap((worktree) => (worktree.branch === null ? [] : [[worktree.branch, worktree] as const])))
      const line: string[] = []
      for (let current = byBranch.get(branch); current !== undefined && current.branch !== null && !current.primary && !line.includes(current.branch); current = current.parent === null ? undefined : byBranch.get(current.parent)) line.unshift(current.branch)
      // The preview's tip is two commits behind its parent, with its checks failing.
      return {
        branches: line.map((name, index) => ({
          branch: name,
          behindParent: index === line.length - 1 && index > 0 ? 2 : 0,
          pullRequest: byBranch.get(name)?.pullRequest === null ? null : { number: byBranch.get(name)?.pullRequest?.number ?? 0, reviewDecision: index === 0 ? 'APPROVED' : null, statusCheckRollup: [{ conclusion: index === line.length - 1 && index > 0 ? 'FAILURE' : 'SUCCESS' }] },
        })),
      }
    },
    stackRun: async () => {
      await wait(1200)
    },
    slashCommands: async (agent) =>
      agent === 'codex'
        ? [{ name: 'model', description: 'Choose the model and reasoning effort', source: 'builtin' }, { name: 'review', description: 'Review my current changes', source: 'builtin' }, { name: 'ship', description: 'Ship the current branch', source: 'user', argumentHint: '[pr]' }]
        : [{ name: 'compact', description: 'Clear history but keep a summary in context', source: 'builtin', argumentHint: '[instructions]' }, { name: 'model', description: 'Set the AI model', source: 'builtin' }, { name: 'review', description: 'Review a pull request', source: 'builtin' }, { name: 'megabrain', description: 'Delegate work to other coding agents', source: 'skill' }, { name: 'deploy', description: 'Deploy this project', source: 'project', argumentHint: '<env>' }],
    queued: async (dispatchId) => [{ id: 'delivery-mock-1', dispatch: dispatchId, type: 'reply', createdAt: new Date().toISOString(), state: 'outstanding', text: 'Use the new scrubber, and keep the old bar behind a flag.' }],
    unqueue: async () => 'Use the new scrubber, and keep the old bar behind a flag.',
    saveAttachment: async (_base64, extension) => `/Users/operator/.megabrain/attachments/mock.${extension}`,
    sendToSession: async (sessionId) => ({ delivered: true, channel: ownedSession(sessionId) ? 'tmux' : 'claude-peer' }),
    openUrl: async (url) => void window.open(url, '_blank', 'noopener'),
    revealPath: async () => {},
    releaseSession: async (sessionId) => {
      taken.delete(sessionId)
      released.add(sessionId)
    },
    ownSession: async (sessionId) => {
      released.delete(sessionId)
      taken.add(sessionId)
    },
    ...createMockMaestroApi(),
    openCodeServer: async (root) => ({ root, url: 'about:blank', port: 0, pid: 0 }),
    stopCodeServer: async () => {},
    openInCode: async (root) => ({ root, url: 'about:blank', port: 0, pid: 0 }),
    settings: async () => settings,
    settingsOnly: async (keys) => Object.fromEntries(keys.map((key) => [key, settings[key]])),
    setPolicy: async (policy) => {
      settings = { ...settings, resources: { ...settings.resources, policy: policy === null ? null : { maxAgents: policy.maxAgents ?? null, minAvailableMib: policy.minAvailableMib ?? null, maxPressure: policy.maxPressure ?? null, maxContainerSuites: policy.maxContainerSuites ?? null } } }
    },
    setResourceHistory: async (enabled) => void (settings = { ...settings, resources: { ...settings.resources, historyEnabled: enabled } }),
    setSupervisor: async (running) => void (settings = { ...settings, supervisor: { running, pid: running ? 21194 : null } }),
    setLimitNotice: async (enabled, intervalSeconds) => void (settings = { ...settings, limits: { ...settings.limits, notice: { enabled, intervalSeconds: intervalSeconds ?? settings.limits.notice.intervalSeconds } } }),
    setLimitProvider: async (provider, enabled) =>
      void (settings = { ...settings, limits: { ...settings.limits, enabledProviders: enabled ? [...new Set([...settings.limits.enabledProviders, provider])] : settings.limits.enabledProviders.filter((item) => item !== provider) } }),
    usageStats: async (days) => {
      await wait(450)
      return mockUsageStats(days)
    },
    saveChain: async (name, chain) => {
      await wait(150)
      const saved = { name, ...chain }
      const index = settings.chains.findIndex((item) => item.name === name)
      settings = { ...settings, chains: index === -1 ? [...settings.chains, saved] : settings.chains.map((item) => (item.name === name ? saved : item)) }
    },
    validateChain: async (_name, chain) => {
      await wait(120)
      const errors = [...validateRule(chain.when, settings.models), ...chain.steps.flatMap((step, index) => (step.when === undefined ? [] : validateRule(step.when, settings.models, `steps[${index}].when`)))]
      return { ok: errors.length === 0, errors }
    },
    chainExplain: async (input) => {
      await wait(150)
      return explainChains(settings.chains, input, settings.limits.readings)
    },
    editStep: async (name, index, patch) => {
      await wait(150)
      const editChain = (chain: Chain): Chain => {
        const step = chain.steps[index]
        if (step === undefined) throw new CliError(`chain ${name} has no step ${index + 1}`, 1)
        const { until, when, ...fields } = patch
        const next: ChainStep = { ...step, ...fields }
        if (until === null) delete next.until
        else if (until !== undefined) next.until = until
        if (when === null) delete next.when
        else if (when !== undefined) next.when = when
        return { ...chain, steps: chain.steps.map((item, position) => (position === index ? next : item)) }
      }
      settings = { ...settings, chains: settings.chains.map((chain) => (chain.name === name ? editChain(chain) : chain)) }
    },
    moveStep: async (name, from, to) => {
      await wait(150)
      settings = {
        ...settings,
        chains: settings.chains.map((chain) => {
          if (chain.name !== name) return chain
          const steps = [...chain.steps]
          const [moved] = steps.splice(from, 1)
          if (moved === undefined || to < 0 || to >= chain.steps.length) throw new CliError(`chain ${name} cannot move step ${from + 1} to ${to + 1}`, 1)
          steps.splice(to, 0, moved)
          return { ...chain, steps }
        }),
      }
    },
    deleteChain: async (name) => void (settings = { ...settings, chains: settings.chains.filter((item) => item.name !== name) }),
    refreshModels: async () => {},
    setTerminalDefault: async (name) => void (settings = { ...settings, terminal: { ...settings.terminal, default: name } }),
    projects: async (origin) => sessionsOfOrigin(listed(), origin),
    projectAppearance: async () => ({ ...appearances }),
    async setProjectAppearance(path, patch) {
      await wait(200)
      const next: ProjectAppearance = { ...appearances[path] }
      for (const key of ['name', 'color', 'picture'] as const) {
        const value = patch[key]
        if (value === null) delete next[key]
        else if (value !== undefined) next[key] = value
      }
      appearances[path] = next
    },
    async archiveWorktree(path, options) {
      await wait(500)
      const project = mockProjects.find((item) => item.worktrees.some((worktree) => worktree.path === path))
      const worktree = project?.worktrees.find((item) => item.path === path)
      if (project === undefined || worktree === undefined || worktree.branch === null) throw new CliError(`${path} is not a worktree megabrain lists.`, 1)
      if (worktree.primary) throw new CliError('The main checkout cannot be archived.', 1)
      // A branch with agent sessions stands in for one with work that is not saved.
      if (options?.force !== true && worktree.sessions.length > 0) throw new CliError(`Refusing to archive ${worktree.branch}:\n  uncommitted: src/app.ts, README.md\n  unpushed: 2 commits ahead of origin/${worktree.branch}`, 1)
      archivedPaths.set(`${project.path}:${worktree.branch}`, path)
      archived = [...archived, { repo: project.path, branch: worktree.branch, head: worktree.head, archivedAt: new Date().toISOString(), parent: worktree.parent, pullRequest: worktree.pullRequest }]
    },
    archivedWorktrees: async (repo) => archived.filter((entry) => repo === undefined || entry.repo === repo),
    async unarchiveWorktree(repo, branch) {
      await wait(500)
      if (!archived.some((entry) => entry.repo === repo && entry.branch === branch)) throw new CliError(`${branch} is not archived in ${repo}.`, 1)
      archived = archived.filter((entry) => !(entry.repo === repo && entry.branch === branch))
      archivedPaths.delete(`${repo}:${branch}`)
    },
    pickImage: async () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0ea5e9"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>'),
    projectScripts: async (root) => scriptsFor(root),
    runScript: async (_worktree, script) => ({ script, session: `mock-${script}`, pid: 1, alreadyRunning: false, port: null }),
    stopScript: async () => {},
    portWho: async (port) => ({ port, listeners: [] }),
    portFree: async (from) => from,
    portKill: async () => {},
    async setProjectScripts(root, scripts) {
      const repo = scriptsFor(root).repo
      const saved = { ...savedScripts.get(repo) }
      for (const [name, command] of Object.entries(scripts) as ['run' | 'build' | 'install', string][]) {
        if (command === '') delete saved[name]
        else saved[name] = command
      }
      savedScripts.set(repo, saved)
      return scriptsFor(root)
    },
    importFolder: async (path) => mockImported(path, null),
    importClone: async (url, into) => {
      await wait(1200)
      return mockImported(`${into}/${url.split('/').at(-1) ?? 'repo'}`, url)
    },
    githubRepositories: async (owner) => {
      await wait(500)
      return mockGithubRepositories.filter((repository) => owner === undefined || repository.nameWithOwner.startsWith(`${owner ?? 'operator'}/`))
    },
    githubOwners: async () => mockGithubOwners,
    discoverRepositories: async () => {
      await wait(700)
      return mockDiscovered
    },
    homeDir: async () => '/Users/operator',
    githubPullRequests: async (_root, state, limit, after) => {
      await wait(450)
      return { ...mockGithubPullRequests, ...mockPage(mockGithubPullRequests.items, state, limit, after) }
    },
    githubIssues: async (_root, state, limit, after) => {
      await wait(400)
      return { ...mockGithubIssues, ...mockPage(mockGithubIssues.items, state, limit, after) }
    },
    githubPullRequest: async (_root, number) => {
      await wait(300)
      return githubEdited('pr', mockGithubDetail('pr', number))
    },
    githubIssue: async (_root, number) => {
      await wait(300)
      return githubEdited('issue', mockGithubDetail('issue', number))
    },
    ...reviewApi,
    submitReview: async (_root, number, review) => {
      await wait(500)
      if (number === 109) throw new CliError('gh: Can not approve your own pull request (HTTP 422)', 1)
      const comments = review.comments ?? []
      const verdict = review.event === 'approve' ? 'Approved' : review.event === 'request-changes' ? 'Requested changes' : 'Reviewed'
      const lines = comments.map((comment) => `- ${comment.path}:${comment.line} — ${comment.body}`)
      githubComment('pr', number, [`**${verdict}**`, review.body, ...lines].filter((line) => line !== '').join('\n\n'))
    },
    addComment: async (_root, number, body) => {
      await wait(400)
      // A number is a pull request or an issue; GitHub shares one sequence between them.
      githubComment(mockGithubPullRequests.items.some((item) => item.number === number) ? 'pr' : 'issue', number, body)
    },
    setIssueState: async (_root, number, state) => {
      await wait(400)
      githubStates.set(`issue:${number}`, state)
    },
    setPrState: async (_root, number, action) => {
      await wait(600)
      if (action === 'merge' && number === 111) throw new CliError('gh: Pull request is not mergeable: the base branch policy prohibits the merge.', 1)
      githubStates.set(`pr:${number}`, action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'open')
    },
    pickFolder: async () => '/Users/operator/Workspaces/new-project',
    copyText: (text) => navigator.clipboard.writeText(text),
    pasteText: () => navigator.clipboard.readText(),
    copyImage: (png) => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as BlobPart], { type: 'image/png' }) })]),
    pasteImage: async () => null,
    saveImageAs: async (bytes, name) => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([bytes as BlobPart]))
      link.download = name
      link.click()
      URL.revokeObjectURL(link.href)
      return true
    },
    codeTree: async () => mockCodeTree,
    codeRead: async (_root, path) => {
      const text = mockCodeFiles[path]
      return { path, text: text ?? `// ${path}`, binary: false, tooLarge: false }
    },
    codeChanges: async () => mockCodeChanges,
    codeDiff: async (_root, path) => ({ ...(isNew(mockCodeChanges, path) ? mockNewFileDiff : mockCodeDiff), path }),
    codeBranchChanges: async () => mockBranchChanges,
    codeBranchDiff: async (_root, _mergeBase, path) => ({ ...(isNew(mockBranchChanges.changes, path) ? mockNewFileDiff : mockCodeDiff), path }),
    chats: async () => [mockNativeChat, mockLongChat, mockCutChat, mockCodexChat],
    startChat: async ({ agent, model, cwd }) => ({ ...mockNativeChat, id: `chat-${Date.now()}`, agent, model: model ?? null, cwd, title: null, state: 'starting' }),
    sendChat: async (chatId, parts) => {
      await wait(250)
      const sent = sendMockChat(chatId, parts)
      // The agent updates its plan while it answers.
      setTimeout(() => {
        if (touchMockChatArtifact(chatId)) publishMockArtifacts(chatId)
      }, 1800)
      return sent
    },
    forkChat: async (chatId, eventId) => {
      await wait(400)
      return forkMockChat(chatId, eventId)
    },
    editLastMessage: async (chatId, parts) => {
      await wait(250)
      return editLastMockChat(chatId, parts)
    },
    resumeChat: async () => {},
    chatQueue: async (chatId, change) => changeMockQueue(chatId, change),
    interruptChat: async (chatId) => interruptMockChat(chatId),
    answerApproval: async (chatId, _approvalId, decision) => answerMockApproval(chatId, decision),
    stopChat: async () => {},
    removeChat: async () => {},
    setChatModel: async () => {},
    summarizeChat: async () => {},
    knowledge: async (repo) => {
      await wait(200)
      const saved = parseKnowledgeSettings(knowledgeSettings, chatSummaries)
      return mockKnowledgeList(repo, (path) => inEffect(effectiveToggles(saved, path), 'summaries'))
    },
    searchKnowledge: async (text, repo) => mockKnowledgeSearch(text, repo),
    knowledgeTopic: async (id) => {
      await wait(150)
      const found = mockKnowledgeTopics.find((entry) => entry.id === id)
      if (found === undefined) throw new CliError(`no topic ${id}`, 1)
      return found
    },
    knowledgeTranscript: async (chatId) => {
      await wait(150)
      const found = mockKnowledgeTranscript(chatId)
      if (found === null) throw new CliError(`no chat ${chatId}`, 1)
      return found
    },
    artifacts: async (options) => {
      await wait(200)
      return mockArtifactList(options)
    },
    artifact: async (id, revision) => {
      const found = mockArtifact(id, revision)
      if (found === null) throw new CliError(revision === undefined ? `unknown artifact: ${id}` : `unknown artifact revision ${revision} for ${id}`, 1)
      return found
    },
    chatArtifacts: async (chatId) => {
      await wait(120)
      return mockChatArtifacts(chatId)
    },
    chatArtifact: async (chatId, artifactId, revision) => {
      await wait(120)
      const found = mockChatArtifact(chatId, artifactId, revision)
      if (found === null) throw new CliError(revision === undefined ? `unknown artifact: ${artifactId}` : `unknown revision ${revision} of ${artifactId}`, 1)
      return found
    },
    setChatMode: async (chatId, mode) => ({
      chat: setMockChatMode(chatId, mode),
      terminal: mode === 'terminal' ? { id: 'term-mock', engine: 'native', cwd: mockNativeChat.cwd, title: 'claude', tmuxSession: null } : null,
      command: mode === 'terminal' ? ['claude', '--resume', mockNativeChat.agentSessionId ?? ''] : null,
    }),
    takeOverChat: async (chatId) => {
      await wait(300)
      return takeOverMockChat(chatId)
    },
    chatTerminalCommand: async () => ['claude', '--resume', mockNativeChat.agentSessionId ?? ''],
    agentDefaults: async () => ({
      agents: [
        { agent: 'claude', model: 'opus', effort: 'high' },
        { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' },
        { agent: 'grok', model: null, effort: null },
        { agent: 'agy', model: 'Gemini 3.8 Flash', effort: 'medium' },
      ],
      shell: 'zsh',
    }),
    agentCommand: async (agent, options = {}) => {
      if (!mockInstallPlan.agents.some((entry) => entry.agent === agent && entry.installed)) throw new CliError(`${agent} is not installed`, 1)
      const resume = options.resume === undefined ? [] : agent === 'codex' ? ['resume', options.resume] : ['--resume', options.resume]
      return [agent, ...resume, ...(options.model === undefined ? [] : ['--model', options.model]), ...(options.effort === undefined ? [] : ['--effort', options.effort])]
    },
    sessionHistory: async (_cwd, agent) => {
      await wait(500)
      return mockSessionHistory.filter((session) => agent === undefined || session.agent === agent)
    },
    followChat: async (chatId, since, onLine) => followMockChat(chatId, since, onLine),
    chatEvents: async (chatId, since) => readMockChat(chatId, since),
    logSwitchTrace: async () => {},
    logChatStartTrace: async () => {},
    openTerminal: async ({ engine, cwd, tmuxSession }) => ({ id: `term-${Date.now()}`, engine, cwd, title: 'zsh', tmuxSession: tmuxSession ?? null }),
    writeTerminal: async () => {},
    resizeTerminal: async () => {},
    closeTerminal: async () => {},
    listAppTerminals: async () => [],
    onTerminalData: async (_terminalId, onData) => {
      onData(btoa('mock terminal\r\n$ '))
      return () => {}
    },
    setTerminalEngine: async () => {},
    sidebarFolders: async () => sidebarFolders,
    setSidebarFolders: async (json) => void (sidebarFolders = JSON.parse(json) as unknown),
    sidebarState: async () => sidebarState,
    setSidebarState: async (json) => void (sidebarState = JSON.parse(json) as unknown),
    usageOrder: async () => usageOrder,
    worktreeLocation: async () => worktreeLocation,
    setWorktreeLocation: async (json) => void (worktreeLocation = JSON.parse(json) as unknown),
    chatSummaries: async () => chatSummaries,
    setChatSummaries: async (json) => void (chatSummaries = JSON.parse(json) as unknown),
    knowledgeSettings: async () => knowledgeSettings,
    setKnowledgeSettings: async (json) => void (knowledgeSettings = JSON.parse(json) as unknown),
    agentSettings: async () => agentSettings,
    setAgentSettings: async (json) => void (agentSettings = JSON.parse(json) as unknown),
    agentUpdates: async () => {
      await wait(400)
      return { agents: agentUpdates }
    },
    agentUpdate: async (agent) => {
      await wait(2500)
      const entry = agentUpdates.find((item) => item.agent === agent)
      if (entry === undefined || entry.installed === null) throw new CliError(`${agent} is not installed`, 1)
      if (agent === 'grok') throw new CliError('npm error code EACCES', 1)
      const installed = entry.latest ?? entry.installed
      agentUpdates = agentUpdates.map((item) => (item.agent === agent ? { ...item, installed, status: 'updated', checkedAt: new Date().toISOString(), lastAttempt: { at: new Date().toISOString(), ok: true, error: null } } : item))
      return { agent, installed }
    },
    agentUpdateSettings: async () => agentUpdateSettings,
    setAgentUpdateSettings: async (json) => void (agentUpdateSettings = JSON.parse(json) as unknown),
    modelSettings: async () => modelSettings,
    setModelSettings: async (json) => {
      modelSettings = JSON.parse(json) as unknown
      // As the CLI does: a saved toggle wins, else a model is on when it is current.
      const toggles = (modelSettings as { models?: Record<string, boolean> }).models ?? {}
      settings = { ...settings, models: settings.models.map((model) => ({ ...model, enabled: toggles[`${model.agent}/${model.model}`] ?? model.status === 'current' })) }
    },
    setUsageOrder: async (json) => void (usageOrder = JSON.parse(json) as unknown),
    shortcuts: async () => shortcuts,
    setShortcuts: async (json) => void (shortcuts = JSON.parse(json) as unknown),
  }
}
