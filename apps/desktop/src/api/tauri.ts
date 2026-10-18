import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { homeDir } from '@tauri-apps/api/path'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { readImage, readText, writeImage, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { z } from 'zod'
import { projectsArgs } from '@/api/projects-origin'
import { chatDaemonRetireSchema } from '@/api/schema'
import { base64Of, pngFile } from '@/lib/image-bytes'
import { CliError, type DesktopApi, type InstallExit, type PathLink } from '@/api/adapter'
import { chatStreamReader, streamMarkerSchema } from '@/api/chat-stream'
import { usageStatsSchema, agentAutoUpdateSettingsSchema, agentUpdateReportSchema, agentUpdatesSchema, agentCommandSchema, agentDefaultsSchema, knowledgeListSchema, knowledgeSearchSchema, knowledgeTopicSchema, knowledgeTranscriptSchema, artifactListSchema, artifactContentSchema, chatArtifactListSchema, chatArtifactContentSchema, sessionHistorySchema, chatEventLineSchema, chatDaemonStatusSchema, nativeChatSchema, terminalSessionSchema, githubDetailSchema, githubPullRequestFileSchema, githubPullRequestFilesPageSchema, githubReviewThreadSchema, githubReviewerSchema, githubReviewersSchema, githubImageSchema, githubActionRunsSchema, githubActionRunDetailSchema, githubActionLogSchema, githubIssueListSchema, githubPullRequestListSchema, queuedMessageSchema, slashCommandSchema, stackShowSchema, codeServerSchema, sendResultSchema, settingsSchema, githubRepositorySchema, githubOwnerSchema, discoveredRepositorySchema, projectScriptsSchema, runScriptSchema, projectAppearancesSchema, archivedWorktreeSchema, portFreeSchema, portKillSchema, portListenersSchema, projectsSchema, repositorySchema, chatReadSchema, branchChangesSchema, codeChangeSchema, codeDiffSchema, codeEntrySchema, codeFileSchema, dispatchMessagesSchema, doctorReportSchema, transcriptSchema, installEventSchema, installPlanSchema, moduleResultSchema, replyResultSchema, statusSchema, worktreeListSchema, type ChainBody, type ChainExplainInput, chainExplainSchema, chainValidationSchema, chatQueueItemSchema, maestroEventSchema, maestroFlowSchema, maestroRunSchema, simulatorListSchema, bootedSimulatorListSchema, simulatorShutdownSchema, simulatorRestartSchema, inputStartSchema, inputStatusSchema, inputStopSchema, inputActionSchema, inputFrameSchema } from '@/api/schema'

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const firstLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

/** Narrows a knowledge read to one repository. */
const repoArgs = (repo: string | undefined): string[] => (repo === undefined ? [] : ['--repo', repo])

// Some verbs report a problem through their exit code and still print the JSON (doctor exits 1 when a
// module is unhealthy), so the JSON wins whenever there is some.
async function cliJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.stdout.trim() === '') throw new CliError(firstLine(output.stderr) || `megabrain ${args[0]} exited ${output.code}`, output.code)
  const body: unknown = JSON.parse(output.stdout)
  const refusal = z.looseObject({ refusal: z.looseObject({ code: z.string(), message: z.string() }) }).safeParse(body)
  if (refusal.success) throw new CliError(refusal.data.refusal.message, output.code, refusal.data.refusal.code)
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new CliError(`megabrain ${args.join(' ')} answered in an unexpected shape: ${parsed.error.message}`, output.code)
  return parsed.data
}

// A write verb: success is exit 0; its output is not parsed.
async function cliText(args: string[]): Promise<string> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.code !== 0) throw new CliError(firstLine(output.stderr) || firstLine(output.stdout) || `megabrain ${args[0]} exited ${output.code}`, output.code)
  return output.stdout
}

// A long-lived CLI process whose stdout lines arrive as they are printed (native command
// cli_stream, owned by src-tauri); the returned function kills it.
async function cliStream(args: string[], onLine: (line: string) => void): Promise<() => void> {
  const channel = new Channel<string>()
  // A handler that throws would hold back every later message on the channel, so it never does.
  channel.onmessage = (line) => {
    try {
      onLine(line)
    } catch (caught) {
      console.error(caught)
    }
  }
  const streamId = await invoke<string>('cli_stream', { args, onLine: channel })
  return () => void invoke('cli_stream_stop', { streamId })
}

// `native` verbs answer --json with a refusal beside the fields, null on success, and exit non-zero when it is set.
async function nativeJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const answer = await cliJson(args, z.looseObject({ refusal: z.looseObject({ message: z.string() }).nullable().optional() }))
  if (answer.refusal != null) throw new CliError(answer.refusal.message, 1)
  return schema.parse(answer)
}

// `github pr-file` answers with the file under `file`, beside the repository and number.
const pullRequestFileSchema = z.looseObject({ file: githubPullRequestFileSchema })

const appTerminalSchema = z.looseObject({ id: z.string(), sessionName: z.string(), cwd: z.string(), title: z.string(), command: z.string(), alive: z.boolean(), createdAt: z.string() })

// Terminal bytes come base64 over a channel; exit arrives once with the code.
async function terminalListen(terminalId: string, onData: (base64: string) => void, onExit: (code: number | null) => void): Promise<() => void> {
  const channel = new Channel<{ data?: string; exit?: number | null }>()
  channel.onmessage = (message) => {
    if (message.data !== undefined) onData(message.data)
    if ('exit' in message) onExit(message.exit ?? null)
  }
  await invoke('terminal_listen', { terminalId, onEvent: channel })
  return () => void invoke('terminal_unlisten', { terminalId })
}

// Priority travels as its own flag and is left out at 0, the default. Step numbers are 1-based on the
// command line and array positions in the app; the conversion happens here and nowhere else.
const chainSaveArgs = (name: string, chain: ChainBody): string[] => [
  'chain',
  'save',
  name,
  '--when',
  JSON.stringify(chain.when),
  '--steps',
  JSON.stringify(chain.steps.map(({ stale: _stale, reason: _reason, suggested: _suggested, ...step }) => step)),
  ...(chain.priority === undefined || chain.priority === 0 ? [] : ['--priority', String(chain.priority)]),
  '--json',
]

const explainFlags: Record<keyof ChainExplainInput, string> = {
  parentAgent: '--parent-agent',
  parentModel: '--parent-model',
  parentEffort: '--parent-effort',
  repo: '--repo',
  branch: '--branch',
  label: '--label',
}

let streams = 0

export function createTauriApi(): DesktopApi {
  return {
    kind: 'tauri',
    status: () => cliJson(['status', '--json'], statusSchema),
    installPlan: () => cliJson(['install', '--plan', '--json'], installPlanSchema),
    doctor: () => cliJson(['doctor', '--json'], doctorReportSchema),
    installModule: (args) => cliJson(args, moduleResultSchema),
    async install(args, onEvent) {
      const id = `install-${++streams}`
      const unlisten = await listen<{ id: string; line: string }>('cli-line', ({ payload }) => {
        if (payload.id !== id || payload.line.trim() === '') return
        try {
          const parsed = installEventSchema.safeParse(JSON.parse(payload.line))
          onEvent(parsed.success ? parsed.data : { type: 'warn', message: payload.line })
        } catch {
          onEvent({ type: 'warn', message: payload.line })
        }
      })
      try {
        const output = await invoke<CliOutput>('stream_cli', { id, args })
        return { code: output.code, stderr: output.stderr } satisfies InstallExit
      } finally {
        unlisten()
      }
    },
    pathLink: () => invoke<PathLink>('path_link_state'),
    linkCli: (replace) => invoke<PathLink>('link_cli', { replace }),
    setTraySummary: (findings, lines) => invoke('set_tray_summary', { findings, lines }),
    windowVisible: () => getCurrentWindow().isVisible(),
    worktrees: () => cliJson(['worktree', 'list', '--json'], worktreeListSchema),
    readChat: (dispatchId, lines) => cliJson(['orchestrate', 'read', dispatchId, '--lines', String(lines), '--operator', '--json'], chatReadSchema),
    reply: (dispatchId, text) => cliJson(['orchestrate', 'reply', dispatchId, '--text', text, '--operator', '--json'], replyResultSchema),
    readDispatchMessage: async (dispatchId) => {
      const record = await cliJson(['db', 'show', dispatchId, '--json'], dispatchMessagesSchema)
      return record.messages.filter((message) => message.from === 'child').at(-1)?.text ?? null
    },
    transcript: (target, since) =>
      cliJson(
        ['orchestrate', 'transcript', ...('dispatchId' in target ? [target.dispatchId] : ['--session', target.sessionId]), ...(since === undefined ? [] : ['--since', since]), '--operator', '--json'],
        transcriptSchema,
      ),
    setHidden: async (target, hidden) =>
      void (await cliText('project' in target ? ['repo', hidden ? 'hide' : 'unhide', target.project] : ['worktree', hidden ? 'hide' : 'unhide', target.worktree])),
    removeProject: async (path) => void (await cliText(['repo', 'remove', path])),
    removeWorktree: async (path) => void (await cliText(['worktree', 'finish', path, '--delete-branch'])),
    stackShow: (repo, branch) => cliJson(['stack', 'show', '--repo', repo, '--branch', branch, '--json'], stackShowSchema),
    // sync and merge refuse without --yes; the app asked (merge) or the menu item is the ask (sync).
    stackRun: async (repo, branch, verb, options) =>
      void (await cliText(['stack', verb, '--repo', repo, '--branch', branch, ...(verb === 'pr' ? [] : ['--yes']), ...(options?.draft === true ? ['--draft'] : [])])),
    slashCommands: (agent, cwd) => cliJson(['commands', '--agent', agent, '--cwd', cwd, '--json'], slashCommandSchema.array()),
    queued: (dispatchId) => cliJson(['orchestrate', 'queue', dispatchId, '--operator', '--json'], queuedMessageSchema.array()),
    unqueue: async (itemId) => {
      const result = await cliJson(['orchestrate', 'queue', 'cancel', itemId, '--operator', '--json'], queuedMessageSchema)
      return result.text
    },
    saveAttachment: (base64, extension) => invoke<string>('save_attachment', { base64, extension }),
    sendToSession: (sessionId, text) => cliJson(['send', '--session', sessionId, '--text', text, '--operator', '--json'], sendResultSchema),
    openUrl: (url) => openUrl(url),
    revealPath: (path) => revealItemInDir(path),
    releaseSession: async (sessionId) => void (await cliText(['session', 'release', sessionId, '--json'])),
    ownSession: async (sessionId) => void (await cliText(['session', 'own', sessionId, '--json'])),
    openCodeServer: (root) => cliJson(['code', 'open', root, '--json'], codeServerSchema),
    stopCodeServer: async (root) => void (await cliText(['code', 'stop', root])),
    maestroFlows: (root) => cliJson(['maestro', 'flows', '--worktree', root, '--json'], z.array(maestroFlowSchema)),
    maestroRuns: (root) => cliJson(['maestro', 'runs', '--worktree', root, '--json'], z.array(maestroRunSchema)),
    maestroNewFlow: async (root, name) => (await cliJson(['maestro', 'new', name, '--worktree', root, '--json'], z.looseObject({ path: z.string() }))).path,
    maestroRun: (root, flow, device, onEvent, onEnd) => {
      // As with chat events, the stream's last lines may be the CLI's error and an end marker.
      let error: string | null = null
      return cliStream(['maestro', 'run', flow, '--worktree', root, '--device', device, '--json'], (text) => {
        const value: unknown = JSON.parse(text)
        const marker = streamMarkerSchema.safeParse(value)
        if (marker.success && marker.data.end === true) return onEnd(error)
        if (marker.success && marker.data.error !== undefined) {
          error = marker.data.error
          return
        }
        const event = maestroEventSchema.safeParse(value)
        if (event.success) onEvent(event.data)
      })
    },
    maestroStop: async (root) => void (await cliText(['maestro', 'stop', '--worktree', root, '--json'])),
    simulators: async (kind = 'phone') => (await nativeJson(['native', 'sim', 'list', kind, '--json'], simulatorListSchema)).devices,
    bootSimulator: async (udid, kind = 'phone', worktree) => void (await nativeJson(['native', 'sim', 'ensure', kind, '--device', udid, ...(worktree ? ['--worktree', worktree] : []), '--json'], z.unknown())),
    simClaim: async (udid, worktree) => void (await nativeJson(['native', 'sim', 'claim', udid, '--worktree', worktree, '--json'], z.looseObject({ udid: z.string(), worktree: z.string() }))),
    simRelease: async (udid) => void (await nativeJson(['native', 'sim', 'release', udid, '--json'], z.looseObject({ udid: z.string(), worktree: z.null() }))),
    simRename: async (udid, name) => void (await nativeJson(['native', 'sim', 'rename', udid, name, '--json'], z.looseObject({ udid: z.string(), name: z.string() }))),
    simListBooted: async () => (await nativeJson(['native', 'sim', 'list', '--booted', '--json'], bootedSimulatorListSchema)).devices,
    simShutdown: async (udid) => void (await nativeJson(['native', 'sim', 'shutdown', udid, '--json'], simulatorShutdownSchema)),
    simRestart: async (udid) => void (await nativeJson(['native', 'sim', 'restart', udid, '--json'], simulatorRestartSchema)),
    simulatorsAsleep: async () => (await nativeJson(['native', 'sim', 'idle', '--touch', '--json'], z.looseObject({ asleep: z.array(z.string()) }))).asleep,
    simulatorScreenshot: async (udid) => (await nativeJson(['native', 'sim', 'screenshot', udid, '--json'], z.looseObject({ path: z.string() }))).path,
    inputStart: (udid) => nativeJson(['native', 'input', 'start', udid, '--json'], inputStartSchema),
    inputStop: (udid) => nativeJson(['native', 'input', 'stop', udid, '--json'], inputStopSchema),
    inputTap: (udid, x, y) => nativeJson(['native', 'input', 'tap', udid, String(x), String(y), '--json'], inputActionSchema),
    inputSwipe: (udid, x1, y1, x2, y2, duration) => nativeJson(['native', 'input', 'swipe', udid, String(x1), String(y1), String(x2), String(y2), ...(duration === undefined ? [] : ['--duration', String(duration)]), '--json'], inputActionSchema),
    inputScroll: (udid, x, y, dx, dy) => nativeJson(['native', 'input', 'scroll', udid, String(x), String(y), String(dx), String(dy), '--json'], inputActionSchema),
    inputType: (udid, text) => nativeJson(['native', 'input', 'type', udid, text, '--json'], inputActionSchema),
    inputKey: (udid, name) => nativeJson(['native', 'input', 'key', udid, name, '--json'], inputActionSchema),
    inputButton: (udid, name) => nativeJson(['native', 'input', 'button', udid, name, '--json'], inputActionSchema),
    inputFrame: (udid) => nativeJson(['native', 'input', 'frame', udid, '--json'], inputFrameSchema),
    inputStatus: (udid) => nativeJson(['native', 'input', 'status', udid, '--json'], inputStatusSchema),
    openInCode: (root, path, line) =>
      cliJson(['code', 'goto', root, path, ...(line === undefined ? [] : ['--line', String(line)]), '--json'], codeServerSchema),
    settings: () => cliJson(['settings', '--json'], settingsSchema),
    settingsOnly: (keys) => cliJson(['settings', '--json', '--only', keys.join(',')], settingsSchema.partial()),
    setPolicy: async (policy) => {
      if (policy === null) return void (await cliText(['resources', 'policy', 'off']))
      const args = ['resources', 'policy', 'set']
      if (policy.maxAgents !== undefined) args.push('--max-agents', String(policy.maxAgents))
      if (policy.minAvailableMib !== undefined) args.push('--min-available-mib', String(policy.minAvailableMib))
      if (policy.maxPressure !== undefined) args.push('--max-pressure', policy.maxPressure)
      if (policy.maxContainerSuites !== undefined) args.push('--max-container-suites', String(policy.maxContainerSuites))
      await cliText(args)
    },
    setResourceHistory: async (enabled) => void (await cliText(['resources', enabled ? 'enable' : 'disable'])),
    setSupervisor: async (running) => void (await cliText(running ? ['supervise'] : ['supervise', '--stop'])),
    setLimitNotice: async (enabled, intervalSeconds) =>
      void (await cliText(['chain', 'limits', enabled ? '--notice-on' : '--notice-off', ...(intervalSeconds === undefined ? [] : ['--notice-interval', String(intervalSeconds)])])),
    setLimitProvider: async (provider, enabled) => void (await cliText(['chain', 'limits', enabled ? '--enable' : '--disable', provider])),
    usageStats: (days) => cliJson(['usage', 'stats', ...(days === null ? [] : ['--days', String(days)]), '--json'], usageStatsSchema),
    saveChain: async (name, chain) => void (await cliText(chainSaveArgs(name, chain))),
    validateChain: (name, chain) => cliJson([...chainSaveArgs(name, chain), '--dry-run'], chainValidationSchema),
    chainExplain: async (input) => {
      const flags = Object.entries(explainFlags).flatMap(([field, flag]) => {
        const value = input[field as keyof ChainExplainInput]
        return value === undefined || value === '' ? [] : [flag, value]
      })
      const explained = await cliJson(['chain', 'explain', ...flags, '--json'], chainExplainSchema)
      return { ...explained, steps: explained.steps.map((step) => ({ ...step, index: step.index - 1 })) }
    },
    editStep: async (name, index, patch) => {
      const args = ['chain', 'step', 'edit', name, String(index + 1)]
      if (patch.agent !== undefined) args.push('--agent', patch.agent)
      if (patch.model !== undefined) args.push('--model', patch.model)
      if (patch.effort !== undefined) args.push('--effort', patch.effort)
      if (patch.until === null) args.push('--no-until')
      else if (patch.until !== undefined) args.push('--until', JSON.stringify(patch.until))
      if (patch.when === null) args.push('--no-when')
      else if (patch.when !== undefined) args.push('--when', JSON.stringify(patch.when))
      void (await cliText([...args, '--json']))
    },
    moveStep: async (name, from, to) => void (await cliText(['chain', 'step', 'move', name, String(from + 1), String(to + 1), '--json'])),
    deleteChain: async (name) => void (await cliText(['chain', 'delete', name, '--json'])),
    refreshModels: async (agent) => void (await cliText(['model', 'refresh', agent])),
    setTerminalDefault: async (name) => void (await cliText(['terminal', 'default', name ?? '--clear'])),
    projects: (origin) => cliJson(projectsArgs(origin), projectsSchema),
    projectAppearance: async () => (await cliJson(['settings', 'get', 'project-appearance', '--json'], projectAppearancesSchema)).projects,
    setProjectAppearance: async (path, patch) => {
      const flags = (['name', 'color', 'picture'] as const).flatMap((key) => {
        const value = patch[key]
        if (value === undefined) return []
        return value === null ? [`--no-${key}`] : [`--${key}`, value]
      })
      await cliText(['settings', 'set', 'project-appearance', path, ...flags, '--json'])
    },
    // A refusal names each uncommitted file and unpushed commit on its own line; the person needs all of them.
    archiveWorktree: async (path, options) => {
      const output = await invoke<CliOutput>('run_cli', { args: ['worktree', 'archive', path, ...(options?.force === true ? ['--force'] : []), '--json'] })
      if (output.code !== 0) throw new CliError(output.stderr.trim() || output.stdout.trim() || `megabrain worktree archive exited ${output.code}`, output.code)
    },
    archivedWorktrees: async (repo) =>
      cliJson(['worktree', 'archived', ...(repo === undefined ? [] : ['--repo', repo]), '--json'], z.union([archivedWorktreeSchema.array(), z.looseObject({ archived: archivedWorktreeSchema.array() }).transform((value) => value.archived)])),
    unarchiveWorktree: async (repo, branch) => void (await cliText(['worktree', 'unarchive', branch, '--repo', repo, '--json'])),
    pickImage: async () => {
      const selected = await open({ directory: false, multiple: false, filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }] })
      return selected ?? null
    },
    projectScripts: (root) => cliJson(['repo', 'scripts', root, '--json'], projectScriptsSchema),
    setProjectScripts: (root, scripts) =>
      cliJson(['repo', 'scripts', root, ...Object.entries(scripts).flatMap(([name, command]) => [`--${name}`, command]), '--json'], projectScriptsSchema),
    runScript: (worktree, script, command) => cliJson(['repo', 'run', worktree, '--worktree', worktree, '--script', script, '--command', command, '--json'], runScriptSchema),
    stopScript: async (worktree, script) => void (await cliText(['repo', 'stop', worktree, '--worktree', worktree, '--script', script])),
    portWho: (port) => cliJson(['port', 'who', String(port), '--json'], portListenersSchema),
    portFree: async (from) => (await cliJson(['port', 'free', '--from', String(from), '--json'], portFreeSchema)).port,
    portKill: async (port) => void (await cliJson(['port', 'kill', String(port), '--json'], portKillSchema)),
    importFolder: (path) => cliJson(['repo', 'add', path, '--json'], repositorySchema),
    importClone: (url, into) => cliJson(['repo', 'clone', url, '--into', into, '--json'], repositorySchema),
    githubRepositories: (owner) => cliJson(['repo', 'github', ...(owner === undefined ? [] : ['--owner', owner]), '--json'], githubRepositorySchema.array()),
    githubOwners: () => cliJson(['repo', 'github', '--orgs', '--json'], githubOwnerSchema.array()),
    discoverRepositories: (roots) => cliJson(['repo', 'discover', ...(roots === undefined ? [] : ['--roots', roots.join(',')]), '--json'], discoveredRepositorySchema.array()),
    homeDir: () => homeDir(),
    githubPullRequests: (root, state, limit, after) => cliJson(['github', 'prs', root, '--state', state, '--limit', String(limit), ...(after === null ? [] : ['--after', after]), '--json'], githubPullRequestListSchema),
    githubIssues: (root, state, limit, after) => cliJson(['github', 'issues', root, '--state', state, '--limit', String(limit), ...(after === null ? [] : ['--after', after]), '--json'], githubIssueListSchema),
    githubPullRequest: (root, number) => cliJson(['github', 'pr', root, String(number), '--json'], githubDetailSchema),
    githubIssue: (root, number) => cliJson(['github', 'issue', root, String(number), '--json'], githubDetailSchema),
    githubActionRuns: (root, options = {}) => cliJson(['github', 'runs', root, ...(options.branch === undefined ? [] : ['--branch', options.branch]), ...(options.workflow === undefined ? [] : ['--workflow', options.workflow]), ...(options.status === undefined ? [] : ['--status', options.status]), ...(options.limit === undefined ? [] : ['--limit', String(options.limit)]), ...(options.after == null ? [] : ['--after', options.after]), '--json'], githubActionRunsSchema),
    githubActionRun: (root, runId) => cliJson(['github', 'run', root, String(runId), '--json'], githubActionRunDetailSchema),
    githubActionRunLog: (root, runId, jobId) => cliJson(['github', 'run-log', root, String(runId), '--job', String(jobId), '--json'], githubActionLogSchema),
    githubActionRunAction: async (root, runId, action) => { await cliText(['github', 'run-action', root, String(runId), action, '--json']) },
    githubWorkflowDispatch: async (root, workflow, ref, inputs) => { await cliText(['github', 'workflow-dispatch', root, workflow, '--ref', ref, ...(inputs === undefined ? [] : ['--inputs', JSON.stringify(inputs)]), '--json']) },
    prFilesPage: (root, number, page, perPage) => cliJson(['github', 'pr-files', root, String(number), '--page', String(page), '--per-page', String(perPage), '--no-patch', '--json'], githubPullRequestFilesPageSchema),
    prFile: async (root, number, path) => (await cliJson(['github', 'pr-file', root, String(number), path, '--json'], pullRequestFileSchema)).file,
    prThreads: (root, number) => cliJson(['github', 'threads', root, String(number), '--json'], githubReviewThreadSchema.array()),
    replyThread: async (root, number, threadId, body) => {
      await cliText(['github', 'thread-reply', root, String(number), threadId, '--body', body, '--json'])
    },
    resolveThread: async (root, number, threadId, resolved) => {
      await cliText(['github', 'thread-resolve', root, String(number), threadId, ...(resolved ? [] : ['--unresolve']), '--json'])
    },
    prReviewers: (root, number) => cliJson(['github', 'reviewers', root, String(number), '--json'], githubReviewersSchema),
    githubImage: (root, url) => cliJson(['github', 'image', root, url, '--json'], githubImageSchema),
    assignableReviewers: (root, query) => cliJson(['github', 'assignable', root, ...(query.trim() === '' ? [] : ['--query', query.trim()]), '--json'], githubReviewerSchema.array()),
    requestReview: async (root, number, logins, remove) => {
      await cliText(['github', 'request-review', root, String(number), '--user', logins.join(','), ...(remove ? ['--remove'] : []), '--json'])
    },
    setPrReady: async (root, number, ready) => {
      await cliText(['github', 'pr-ready', root, String(number), ...(ready ? [] : ['--draft']), '--json'])
    },
    setAutoMerge: async (root, number, method) => {
      await cliText(['github', 'auto-merge', root, String(number), ...(method === null ? ['--disable'] : ['--method', method]), '--json'])
    },
    rerunChecks: async (root, number, failedOnly) => {
      await cliText(['github', 'rerun-checks', root, String(number), ...(failedOnly ? ['--failed'] : []), '--json'])
    },
    setFileViewed: async (root, number, path, viewed) => {
      await cliText(['github', 'file-viewed', root, String(number), path, ...(viewed ? [] : ['--unviewed']), '--json'])
    },
    submitReview: async (root, number, review) => {
      const comments = review.comments ?? []
      await cliText(['github', 'review', root, String(number), '--event', review.event, '--body', review.body, ...(comments.length === 0 ? [] : ['--comments', JSON.stringify(comments)]), '--json'])
    },
    addComment: async (root, number, body) => {
      await cliText(['github', 'comment', root, String(number), '--body', body, '--json'])
    },
    setIssueState: async (root, number, state, reason) => {
      await cliText(['github', 'issue-state', root, String(number), state, ...(reason === undefined ? [] : ['--reason', reason]), '--json'])
    },
    setPrState: async (root, number, action, options) => {
      await cliText(['github', 'pr-state', root, String(number), action, ...(options?.method === undefined ? [] : ['--method', options.method]), '--json'])
    },
    pickFolder: async (defaultPath) => {
      const selected = await open({ directory: true, multiple: false, ...(defaultPath === undefined ? {} : { defaultPath }) })
      return selected ?? null
    },
    copyText: (text) => writeText(text),
    pasteText: () => readText(),
    copyImage: (png) => writeImage(png),
    pasteImage: async () => {
      // readImage throws when the clipboard holds no image.
      const image = await readImage().catch(() => null)
      if (image === null) return null
      const [size, rgba] = await Promise.all([image.size(), image.rgba()])
      return pngFile(rgba, size.width, size.height, 'Pasted image.png')
    },
    saveImageAs: async (bytes, name) => {
      const path = await save({ defaultPath: name })
      if (path === null) return false
      await invoke('save_image', { path, base64: base64Of(bytes) })
      return true
    },
    codeTree: async (root) => codeEntrySchema.array().parse(await invoke('code_tree', { root })),
    codeRead: async (root, path) => codeFileSchema.parse(await invoke('code_read', { root, path })),
    codeChanges: async (root) => codeChangeSchema.array().parse(await invoke('code_changes', { root })),
    codeDiff: async (root, path) => codeDiffSchema.parse(await invoke('code_diff', { root, path })),
    codeBranchChanges: async (root, parent) => branchChangesSchema.parse(await invoke('code_branch_changes', { root, parent })),
    codeBranchDiff: async (root, mergeBase, path) => codeDiffSchema.parse(await invoke('code_branch_diff', { root, mergeBase, path })),
    chats: () => cliJson(['chat', 'list', '--json'], nativeChatSchema.array()),
    startChat: ({ agent, model, effort, cwd, parts }) =>
      cliJson(['chat', 'start', '--agent', agent, ...(model === undefined ? [] : ['--model', model]), ...(effort === undefined ? [] : ['--effort', effort]), '--cwd', cwd, ...(parts === undefined ? [] : ['--parts', JSON.stringify(parts)]), '--json'], nativeChatSchema),
    sendChat: (chatId, parts, options) => cliJson(['chat', 'send', chatId, '--parts', JSON.stringify(parts), ...(options?.fresh === true ? ['--fresh'] : []), '--json'], z.looseObject({ queued: chatQueueItemSchema.nullable() })),
    forkChat: (chatId, eventId) => cliJson(['chat', 'fork', chatId, '--at', eventId, '--json'], nativeChatSchema),
    editLastMessage: (chatId, parts) => cliJson(['chat', 'edit-last', chatId, '--parts', JSON.stringify(parts), '--json'], nativeChatSchema),
    resumeChat: async (chatId) => void (await cliText(['chat', 'resume', chatId, '--json'])),
    chatQueue: (chatId, change) =>
      cliJson(
        [
          'chat',
          'queue',
          change.action,
          chatId,
          ...('itemId' in change ? [change.itemId] : []),
          ...('parts' in change ? ['--parts', JSON.stringify(change.parts)] : []),
          ...('to' in change ? ['--to', String(change.to)] : []),
          '--json',
        ],
        chatQueueItemSchema.array(),
      ),
    interruptChat: async (chatId) => void (await cliText(['chat', 'interrupt', chatId])),
    answerApproval: async (chatId, approvalId, decision) => void (await cliText(['chat', 'approve', chatId, approvalId, '--decision', decision])),
    stopChat: async (chatId) => void (await cliText(['chat', 'stop', chatId])),
    removeChat: async (chatId) => void (await cliText(['chat', 'remove', chatId, '--json'])),
    summarizeChat: async (chatId) => void (await cliText(['chat', 'summarize', chatId, '--json'])),
    knowledge: (repo) => cliJson(['knowledge', 'list', ...repoArgs(repo), '--json'], knowledgeListSchema),
    searchKnowledge: (text, repo) => cliJson(['knowledge', 'search', text, ...repoArgs(repo), '--json'], knowledgeSearchSchema),
    knowledgeTopic: (id) => cliJson(['knowledge', 'show', id, '--json'], knowledgeTopicSchema),
    knowledgeTranscript: (chatId) => cliJson(['knowledge', 'transcript', chatId, '--json'], knowledgeTranscriptSchema),
    artifacts: (options = {}) => cliJson(['artifact', 'list', ...(options.project === undefined ? [] : ['--project', options.project]), ...(options.topic === undefined ? [] : ['--topic', options.topic]), '--json'], artifactListSchema),
    artifact: (id, revision) => cliJson(['artifact', 'show', id, ...(revision === undefined ? [] : ['--revision', String(revision)]), '--json'], artifactContentSchema),
    chatArtifacts: (chatId) => cliJson(['chat', 'artifacts', chatId, '--json'], chatArtifactListSchema),
    chatArtifact: (chatId, artifactId, revision) => cliJson(['chat', 'artifact', chatId, artifactId, ...(revision === undefined ? [] : ['--revision', String(revision)]), '--json'], chatArtifactContentSchema),
    setChatModel: async (chatId, model, effort) => void (await cliText(['chat', 'model', chatId, model, ...(effort === undefined ? [] : ['--effort', effort])])),
    setChatMode: (chatId, mode) =>
      cliJson(['chat', 'mode', chatId, mode, '--json'], z.looseObject({ chat: nativeChatSchema, terminal: terminalSessionSchema.nullable(), command: z.array(z.string()).nullable().default(null) })),
    takeOverChat: (chatId) => cliJson(['chat', 'take-over', chatId, '--json'], nativeChatSchema),
    chatTerminalCommand: (chatId) => cliJson(['chat', 'terminal-command', chatId, '--json'], z.array(z.string())),
    agentDefaults: () => cliJson(['agent', 'defaults', '--json'], agentDefaultsSchema),
    agentCommand: async (agent, options = {}) =>
      (await cliJson(['agent', 'command', agent, ...(options.resume === undefined ? [] : ['--resume', options.resume]), ...(options.model === undefined ? [] : ['--model', options.model]), ...(options.effort === undefined ? [] : ['--effort', options.effort]), '--json'], agentCommandSchema)).argv,
    sessionHistory: (cwd, agent) => cliJson(['sessions', 'history', '--cwd', cwd, ...(agent === undefined ? [] : ['--agent', agent]), '--json'], sessionHistorySchema),
    followChat: (chatId, since, onLine, onEnd) => cliStream(['chat', 'events', chatId, ...(since === null ? [] : ['--since', since]), '--follow', '--json'], chatStreamReader(onLine, onEnd)),
    chatEvents: async (chatId, since) =>
      (await cliText(['chat', 'events', chatId, ...(since === null ? [] : ['--since', since]), '--json']))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => chatEventLineSchema.parse(JSON.parse(line))),
    chatDaemonStatus: () => cliJson(['chat', 'daemon', 'status', '--json'], chatDaemonStatusSchema),
    chatDaemonRetire: () => cliJson(['chat', 'daemon', 'retire', '--json'], chatDaemonRetireSchema),
    chatDaemonDrain: async () => void (await cliText(['chat', 'daemon', 'drain', '--json'])),
    logSwitchTrace: async (record) => void (await invoke('switch_trace_log', { record })),
    logChatStartTrace: async (record) => void (await invoke('chat_start_trace_log', { record })),
    openTerminal: async (options) => terminalSessionSchema.parse(await invoke('terminal_open', { options })),
    writeTerminal: async (terminalId, data) => void (await invoke('terminal_write', { terminalId, data })),
    resizeTerminal: async (terminalId, cols, rows) => void (await invoke('terminal_resize', { terminalId, cols, rows })),
    closeTerminal: async (terminalId, options) => void (await invoke('terminal_close', { terminalId, kill: options?.kill ?? false })),
    listAppTerminals: () => cliJson(['terminal', 'list', '--app', '--json'], z.array(appTerminalSchema)),
    onTerminalData: (terminalId, onData, onExit) => terminalListen(terminalId, onData, onExit),
    setTerminalEngine: async (engine) => void (await cliText(['settings', 'set', 'terminal-engine', engine])),
    sidebarFolders: () => cliJson(['settings', 'get', 'sidebar-folders'], z.unknown()),
    setSidebarFolders: async (json) => void (await cliText(['settings', 'set', 'sidebar-folders', json])),
    sidebarState: () => cliJson(['settings', 'get', 'sidebar-state'], z.unknown()),
    setSidebarState: async (json) => void (await cliText(['settings', 'set', 'sidebar-state', json])),
    usageOrder: () => cliJson(['settings', 'get', 'usage-order'], z.unknown()),
    worktreeLocation: () => cliJson(['settings', 'get', 'worktree-location'], z.unknown()),
    setWorktreeLocation: async (json) => void (await cliText(['settings', 'set', 'worktree-location', json])),
    chatSummaries: () => cliJson(['settings', 'get', 'chat-summaries'], z.unknown()),
    setChatSummaries: async (json) => void (await cliText(['settings', 'set', 'chat-summaries', json])),
    knowledgeSettings: () => cliJson(['settings', 'get', 'knowledge'], z.unknown()),
    setKnowledgeSettings: async (json) => void (await cliText(['settings', 'set', 'knowledge', json])),
    agentSettings: () => cliJson(['settings', 'get', 'agents'], z.unknown()),
    setAgentSettings: async (json) => void (await cliText(['settings', 'set', 'agents', json])),
    agentUpdates: () => cliJson(['agent', 'update', '--check', '--json'], agentUpdatesSchema),
    agentUpdate: (agent) => cliJson(['agent', 'update', agent, '--json'], agentUpdateReportSchema),
    agentUpdateSettings: () => cliJson(['settings', 'get', 'agents-update'], agentAutoUpdateSettingsSchema),
    setAgentUpdateSettings: async (json) => void (await cliText(['settings', 'set', 'agents-update', json])),
    modelSettings: () => cliJson(['settings', 'get', 'models'], z.unknown()),
    setModelSettings: async (json) => void (await cliText(['settings', 'set', 'models', json])),
    setUsageOrder: async (json) => void (await cliText(['settings', 'set', 'usage-order', json])),
    shortcuts: () => cliJson(['settings', 'get', 'shortcuts'], z.unknown()),
    setShortcuts: async (json) => void (await cliText(['settings', 'set', 'shortcuts', json])),
  }
}
