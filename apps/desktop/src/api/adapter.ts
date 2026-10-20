import type { ProjectsOrigin } from '@/api/projects-origin'
import type { DispatchMessage, OrchestrationGraph, OrchestrationTarget, AgentDefaults, AgentUpdateEntry, AgentUpdates, NativeChat, KnowledgeList, KnowledgeSearch, KnowledgeTopic, KnowledgeTranscript, ArtifactContent, ArtifactList, ChatArtifactContent, ChatArtifactList, ChatDaemonStatus, ChatEventLine, MessagePart, TerminalEngine, TerminalSession, GithubDetail, GithubMergeMethod, GithubPullRequestFile, GithubPullRequestFilesPage, GithubReview, GithubReviewThread, GithubReviewer, GithubReviewers, GithubImage, GithubActionRuns, GithubActionRunDetail, GithubActionLog, GithubProjectItem, GithubProjectPage, GithubProjects, GithubProjectArchive, HistorySession, GithubIssueList, GithubPullRequestList, GithubLabel, QueuedMessage, SlashCommand, StackShow, CodeServer, SendResult, AdmissionPolicy, Settings, GithubRepository, GithubOwner, DiscoveredRepository, Project, ProjectAppearance, ProjectScripts, RunScriptResult, ArchivedWorktree, PortListeners, Repository, BranchChanges, ChatRead, CodeChange, CodeDiff, CodeEntry, CodeFile, DoctorReport, InstallEvent, InstallPlan, ModuleResult, ReplyResult, Status, Transcript, Worktree, ChainBody, ChainExplain, ChainExplainInput, ChainValidation, StepPatch, ChatQueueItem, SettingsKey, UsageStats, MaestroEvent, MaestroFlow, MaestroRun, Simulator, BootedSimulator, SimulatorKind, InputStart, InputStatus, InputStop, InputAction, InputFrame, InputStream, InputRotation, WebDevice, ViewportPreset, WebInputAction, WebActionResult, GithubProjectStatusUpdate, GithubProjectStatusUpdateStatus, GithubProjectStatusUpdates, GithubProjectWorkflows } from '@/api/schema'

/** `~/.local/bin/megabrain` as the native side sees it (src-tauri/src/path_link.rs). */
export interface PathLink {
  linkPath: string
  kind: 'missing' | 'ours' | 'other-link' | 'file'
  pointsTo: string | null
  bundled: string
  dirOnPath: boolean
  resolvesTo: string | null
}

export interface InstallExit {
  code: number | null
  stderr: string
}

/** Everything the UI may ask of megabrain. Implemented by the Tauri and mock adapters. */
/** One `chat queue` verb: an edit moves the message to the end, send-now interrupts the turn and sends it, steer puts it into a running Codex turn. */
export type ChatQueueChange =
  | { action: 'list' | 'clear' }
  | { action: 'add'; parts: MessagePart[] }
  | { action: 'edit'; itemId: string; parts: MessagePart[] }
  | { action: 'move'; itemId: string; to: number }
  | { action: 'remove' | 'send-now' | 'steer'; itemId: string }


export interface DesktopApi {
  readonly kind: 'tauri' | 'mock'
  appControlReply(id: string, value: unknown): Promise<void>
  appControlError(id: string, error: string): Promise<void>
  status(): Promise<Status>
  installPlan(): Promise<InstallPlan>
  doctor(): Promise<DoctorReport>
  /** Runs `megabrain install --json …`, calling onEvent for each line as it arrives. */
  install(args: string[], onEvent: (event: InstallEvent) => void): Promise<InstallExit>
  installModule(args: string[]): Promise<ModuleResult>
  pathLink(): Promise<PathLink>
  linkCli(replace: boolean): Promise<PathLink>
  setTraySummary(findings: number, lines: string[]): Promise<void>
  windowVisible(): Promise<boolean>
  worktrees(): Promise<Worktree[]>
  /** A chat's recent output (`orchestrate read`); dispatch ownership is not an access boundary. */
  readChat(dispatchId: string, lines: number): Promise<ChatRead>
  /** A coordinator and every lane in its orchestration tree. */
  orchestrationGraph(target: OrchestrationTarget): Promise<OrchestrationGraph>
  /** Calls onGraph with a full snapshot at once and on every change; onEnd gets the CLI's error, if any. The returned function stops the follow. */
  followOrchestration(target: OrchestrationTarget, onGraph: (graph: OrchestrationGraph) => void, onEnd?: (error: string | null) => void): Promise<() => void>
  /** Sends a message into a chat (`orchestrate reply`); dispatch ownership is not an access boundary. */
  reply(dispatchId: string, text: string): Promise<ReplyResult>
  /** The last message a chat's child sent, in full (`db show`); null when it sent none. */
  readDispatchMessage(dispatchId: string): Promise<string | null>
  /** Everything a chat and its coordinator said to each other, oldest first: the brief, asks, replies, done (`db show`). */
  dispatchMessages(dispatchId: string): Promise<DispatchMessage[]>
  /** Hide or show a project or a worktree in the sidebar (stored by megabrain). */
  setHidden(target: { project: string } | { worktree: string }, hidden: boolean): Promise<void>
  /** Remove a project from the registry; files stay. */
  removeProject(path: string): Promise<void>
  /** Remove a worktree and its branch; refused when the branch has unmerged commits. */
  removeWorktree(path: string): Promise<void>
  /** The stack a branch is in, with review, checks and behind counts (`stack show --branch --json`); needs gh. */
  stackShow(repo: string, branch: string): Promise<StackShow>
  /** Rebase and push, open pull requests for, or merge the stack a branch is in (`stack sync|pr|merge --branch`). */
  stackRun(repo: string, branch: string, verb: 'sync' | 'pr' | 'merge', options?: { draft?: boolean }): Promise<void>
  /** Slash commands an agent offers in a folder. */
  slashCommands(agent: string, cwd: string): Promise<SlashCommand[]>
  /** Messages waiting to reach a megabrain chat. */
  queued(dispatchId: string): Promise<QueuedMessage[]>
  /** Take a queued message back; resolves to its text so it can be edited. */
  unqueue(itemId: string): Promise<string>
  /** Save a pasted or picked image under megabrain's state and return its path for the message. */
  saveAttachment(base64: string, extension: string): Promise<string>
  /** Send a message to any agent session, as the operator. */
  sendToSession(sessionId: string, text: string): Promise<SendResult>
  /** Forget ownership and kill megabrain's tmux session for it, or end an agent the app launched (`session release`). */
  releaseSession(sessionId: string): Promise<void>
  /** Resume a session in a tmux session megabrain owns (`session own`), so the app shows and closes it. */
  ownSession(sessionId: string): Promise<void>
  /** Open an https address in the system's browser, or a mailto address in the mail app. */
  openUrl(url: string): Promise<void>
  /** Show a folder or file in Finder (the file manager on Linux). */
  revealPath(path: string): Promise<void>
  /** A local Code editor for a worktree or repository; started on demand and reused. */
  openCodeServer(root: string): Promise<CodeServer>
  stopCodeServer(root: string): Promise<void>
  /** Open a file (optionally at a line) in the running Code for that root; starts it when needed. */
  openInCode(root: string, path: string, line?: number): Promise<CodeServer>
  /** A worktree's Maestro flows (`maestro flows --json`). */
  maestroFlows(root: string): Promise<MaestroFlow[]>
  /** Every Maestro run of a worktree, newest first (`maestro runs --json`). */
  maestroRuns(root: string): Promise<MaestroRun[]>
  /** Writes .maestro/<name>.yaml from the CLI's template (`maestro new`); resolves to its path in the worktree. */
  maestroNewFlow(root: string, name: string): Promise<string>
  /** Runs a flow (`maestro run --json`), each line as it arrives; onEnd gets the CLI's error, if any. The returned function kills the run's stream. */
  maestroRun(root: string, flow: string, device: string, onEvent: (event: MaestroEvent) => void, onEnd: (error: string | null) => void): Promise<() => void>
  /** Stops the worktree's running flow (`maestro stop`). */
  maestroStop(root: string): Promise<void>
  /** The iPhone or Apple TV simulators (`native sim list phone|tv --json`); phones when no kind is given. */
  simulators(kind?: SimulatorKind): Promise<Simulator[]>
  /** Boots a simulator headless and waits for it (`native sim ensure phone|tv --device`). */
  bootSimulator(udid: string, kind?: SimulatorKind, worktree?: string): Promise<void>
  /** Assigns a booted simulator to this worktree. */
  simClaim(udid: string, worktree: string): Promise<void>
  /** Removes a simulator's worktree assignment. */
  simRelease(udid: string): Promise<void>
  /** Renames a simulator in CoreSimulator. */
  simRename(udid: string, name: string): Promise<void>
  /** The booted simulators, phones and TVs (`native sim list --booted --json`). */
  simListBooted(): Promise<BootedSimulator[]>
  /** Shuts down one simulator by UDID. */
  simShutdown(udid: string): Promise<void>
  /** Restarts one simulator headless and waits for it to boot. */
  simRestart(udid: string): Promise<void>
  /** The simulators megabrain shut down when idle, and a sign the Device tab shows (`native sim idle --touch --json`). */
  simulatorsAsleep(): Promise<string[]>
  /** A fresh screenshot of a booted simulator (`native sim screenshot`); resolves to the file's path. */
  simulatorScreenshot(udid: string): Promise<string>
  inputStart(udid: string): Promise<InputStart>
  inputStatus(udid: string): Promise<InputStatus>
  inputStop(udid: string): Promise<InputStop>
  inputTap(udid: string, x: number, y: number): Promise<InputAction>
  inputSwipe(udid: string, x1: number, y1: number, x2: number, y2: number, duration?: number): Promise<InputAction>
  inputScroll(udid: string, x: number, y: number, dx: number, dy: number): Promise<InputAction>
  inputType(udid: string, text: string): Promise<InputAction>
  inputKey(udid: string, name: string): Promise<InputAction>
  inputButton(udid: string, name: string): Promise<InputAction>
  inputFrame(udid: string): Promise<InputFrame>
  inputStream(udid: string): Promise<InputStream>
  inputRotate(udid: string, orientation: 'portrait' | 'landscape'): Promise<InputRotation>
  webDeviceList(): Promise<WebDevice[]>
  webDeviceStart(url: string, preset: string | null, worktree: string | null): Promise<WebDevice>
  webDeviceStop(id: string): Promise<void>
  webDeviceInput(id: string, action: WebInputAction): Promise<WebActionResult>
  webDeviceViewport(id: string, preset: string, landscape: boolean): Promise<WebDevice>
  webDevicePresets(): Promise<ViewportPreset[]>
  /** Everything the Settings window shows. */
  settings(): Promise<Settings>
  /** Only some top-level keys (`settings --json --only`), so one page never waits on another's work. */
  settingsOnly(keys: SettingsKey[]): Promise<Partial<Settings>>
  /** Set the admission policy; null turns it off. */
  setPolicy(policy: AdmissionPolicy | null): Promise<void>
  setResourceHistory(enabled: boolean): Promise<void>
  setSupervisor(running: boolean): Promise<void>
  setLimitNotice(enabled: boolean, intervalSeconds?: number): Promise<void>
  setLimitProvider(provider: string, enabled: boolean): Promise<void>
  /** Token usage per day and provider from the agents' logs (`usage stats --json`); null days is all time. */
  usageStats(days: number | null): Promise<UsageStats>
  /** Create or replace a chain. */
  saveChain(name: string, chain: ChainBody): Promise<void>
  /** Checks a chain without saving it (`chain save --dry-run`). */
  validateChain(name: string, chain: ChainBody): Promise<ChainValidation>
  /** Which chain a dispatch like this would get, and which of its steps run. Step indexes are array positions. */
  chainExplain(input: ChainExplainInput): Promise<ChainExplain>
  /** Changes one step in place; `index` is its array position. */
  editStep(name: string, index: number, patch: StepPatch): Promise<void>
  /** Moves a step from one array position to another. */
  moveStep(name: string, from: number, to: number): Promise<void>
  deleteChain(name: string): Promise<void>
  refreshModels(agent: string): Promise<void>
  /** null clears the default. */
  setTerminalDefault(name: string | null): Promise<void>
  /** Every registered project, its worktrees and the agent sessions of that origin in them. */
  projects(origin: ProjectsOrigin): Promise<Project[]>
  /** A project's run, build and install commands (`repo scripts`); a worktree path reads its repository's. */
  projectScripts(root: string): Promise<ProjectScripts>
  /** Save some of them; an empty string returns that one to detection. */
  setProjectScripts(root: string, scripts: Partial<Record<'run' | 'build' | 'install', string>>): Promise<ProjectScripts>
  /** Starts a script as a managed process in a worktree under the resource policy (`repo run`); resolves once it runs, waits while queued, rejects when refused. */
  runScript(worktree: string, script: 'run' | 'build' | 'install', command: string): Promise<RunScriptResult>
  /** Stops a script started with `runScript` (`repo stop`). */
  stopScript(worktree: string, script: 'run' | 'build' | 'install'): Promise<void>
  /** How each project is shown in megabrain, by repository path (`settings get project-appearance`); the repository is never touched. */
  projectAppearance(): Promise<Record<string, ProjectAppearance>>
  /** Sets or clears (null) a project's display name, colour or picture; the picture is an image file megabrain copies. */
  setProjectAppearance(path: string, patch: ProjectAppearancePatch): Promise<void>
  /** Removes a worktree's folder and keeps its branch (`worktree archive`); refused with megabrain's reasons unless forced. */
  archiveWorktree(path: string, options?: { force?: boolean }): Promise<void>
  /** The branches megabrain archived, for one repository or all (`worktree archived`). */
  archivedWorktrees(repo?: string): Promise<ArchivedWorktree[]>
  /** Recreates an archived branch's worktree where it was (`worktree unarchive`). */
  unarchiveWorktree(repo: string, branch: string): Promise<void>
  /** Ask the person for an image with the native picker; null when cancelled. */
  pickImage(): Promise<string | null>
  /** What listens on a TCP port (`port who`). */
  portWho(port: number): Promise<PortListeners>
  /** The first port from `from` up that nothing listens on (`port free`). */
  portFree(from: number): Promise<number>
  /** Stops the caller's own process tree holding the port (`port kill`); another user's is refused. */
  portKill(port: number): Promise<void>
  /** Import a local git repository folder into the registry. */
  importFolder(path: string): Promise<Repository>
  /** Clone a repository and register it; `into` is the parent folder. */
  importClone(url: string, into: string): Promise<Repository>
  /** Repositories on GitHub the person can clone: their own, or one owner's (`repo github --owner`). */
  githubRepositories(owner?: string): Promise<GithubRepository[]>
  /** The signed-in GitHub account, then its organisations (`repo github --orgs`). */
  githubOwners(): Promise<GithubOwner[]>
  /** Git repositories on disk that are not registered yet (`repo discover`); roots replace the CLI's defaults. */
  discoverRepositories(roots?: string[]): Promise<DiscoveredRepository[]>
  /** The person's home folder. */
  homeDir(): Promise<string>
  /** One page of a repository's pull requests through gh (`github prs`), after a cursor; the CLI caches each answer for 60 s. */
  githubPullRequests(root: string, state: 'open' | 'closed' | 'merged' | 'all', limit: number, after: string | null, filters?: { labels?: string[]; author?: string; draft?: boolean; search?: string }): Promise<GithubPullRequestList>
  /** One page of a repository's issues through gh (`github issues`). */
  githubIssues(root: string, state: 'open' | 'closed' | 'all', limit: number, after: string | null, filters?: { labels?: string[]; assignee?: string | null; search?: string }): Promise<GithubIssueList>
  /** Every label in the repository, paged by the CLI until complete. */
  githubLabels(root: string): Promise<GithubLabel[]>
  /** GitHub Projects v2 boards linked to this repository or containing one of its items. */
  githubProjects(root: string): Promise<GithubProjects>
  /** One page of a GitHub Project v2 board's items. */
  githubProject(root: string, number: number, owner?: string, after?: string | null): Promise<GithubProjectPage>
  /** GitHub login for the signed-in viewer, cached by the adapter. */
  githubViewerLogin(): Promise<string>
  /** Applies a stored GitHub view filter locally and reports unsupported qualifiers. */
  githubProjectFilter(project: import('@/api/schema').GithubProject, items: GithubProjectItem[], filter: string, options?: { today?: string; me?: string }): { items: GithubProjectItem[]; warnings: string[] }
  /** Move a project item to a status option; writes through GitHub Projects v2. */
  githubProjectMove(root: string, number: number, itemId: string, status: string, owner?: string): Promise<GithubProjectItem>
  /** Set a typed GitHub Projects field value after validating it against the project schema. */
  githubProjectSetField(root: string, number: number, itemId: string, field: string, type: 'single-select' | 'number' | 'date' | 'text' | 'iteration', value: string, owner?: string): Promise<GithubProjectItem>
  /** Clear a field value on a GitHub Projects item. */
  githubProjectClearField(root: string, number: number, itemId: string, field: string, owner?: string): Promise<GithubProjectItem>
  /** Add an existing GitHub issue or pull request by URL or owner/repo#number. */
  githubProjectAddItem(root: string, number: number, reference: string, owner?: string): Promise<GithubProjectItem>
  /** Create a draft issue inside a GitHub Project. */
  githubProjectCreateDraft(root: string, number: number, title: string, body?: string, owner?: string): Promise<GithubProjectItem>
  /** Edit a project's draft issue title and body. */
  githubProjectEditDraft(root: string, number: number, itemId: string, title: string, body: string, owner?: string): Promise<GithubProjectItem>
  /** Archive or unarchive one project item. */
  githubProjectSetArchived(root: string, number: number, itemId: string, archived: boolean, owner?: string): Promise<GithubProjectArchive>
  /** Every status update on a GitHub Project v2 board. */
  githubProjectStatus(root: string, number: number, owner?: string): Promise<GithubProjectStatusUpdates>
  /** Creates one GitHub Project v2 status update. */
  githubProjectStatusCreate(root: string, number: number, status: GithubProjectStatusUpdateStatus, body?: string, startDate?: string, targetDate?: string, owner?: string): Promise<GithubProjectStatusUpdate>
  /** Every workflow configured on a GitHub Project v2 board. */
  githubProjectWorkflows(root: string, number: number, owner?: string): Promise<GithubProjectWorkflows>
  /** One pull request's body, comments, checks, review decision and line counts (`github pr`). */
  githubPullRequest(root: string, number: number): Promise<GithubDetail>
  /** One issue's body and comments (`github issue`). */
  githubIssue(root: string, number: number): Promise<GithubDetail>
  /** Workflow runs and available workflows (`github runs`). */
  githubActionRuns(root: string, options?: { branch?: string; workflow?: string; status?: string; limit?: number; after?: string | null }): Promise<GithubActionRuns>
  /** One workflow run with its jobs and steps (`github run`). */
  githubActionRun(root: string, runId: number): Promise<GithubActionRunDetail>
  /** A job's log (`github run-log`). */
  githubActionRunLog(root: string, runId: number, jobId: number): Promise<GithubActionLog>
  /** Reruns or cancels a workflow run (`github run-action`). */
  githubActionRunAction(root: string, runId: number, action: 'rerun' | 'rerun-failed' | 'cancel'): Promise<void>
  /** Dispatches a workflow (`github workflow-dispatch`). */
  githubWorkflowDispatch(root: string, workflow: string, ref: string, inputs?: Record<string, string>): Promise<void>
  /** One page of a pull request's changed files without their patches (`github pr-files --page --no-patch`). */
  prFilesPage(root: string, number: number, page: number, perPage: number): Promise<GithubPullRequestFilesPage>
  /** One changed file with its patch (`github pr-file`). */
  prFile(root: string, number: number, path: string): Promise<GithubPullRequestFile>
  /** The review threads on the diff (`github threads`). */
  prThreads(root: string, number: number): Promise<GithubReviewThread[]>
  /** Answers a review thread (`github thread-reply`). */
  replyThread(root: string, number: number, threadId: string, body: string): Promise<void>
  /** Resolves a review thread, or reopens it with resolved false (`github thread-resolve`). */
  resolveThread(root: string, number: number, threadId: string, resolved: boolean): Promise<void>
  /** Who is asked to review, the reviews given, mergeability and the required checks (`github reviewers`). */
  prReviewers(root: string, number: number): Promise<GithubReviewers>
  /** A picture a body links from a GitHub repository, read with gh's token (`github image`). */
  githubImage(root: string, url: string): Promise<GithubImage>
  /** Up to 50 people and teams who can be asked to review, matching the query (`github assignable`). */
  assignableReviewers(root: string, query: string): Promise<GithubReviewer[]>
  /** Asks the logins for a review, or withdraws the request with remove (`github request-review`). */
  requestReview(root: string, number: number, logins: string[], remove: boolean): Promise<void>
  /** Marks a draft ready for review, or with ready false turns it back into a draft (`github pr-ready`). */
  setPrReady(root: string, number: number, ready: boolean): Promise<void>
  /** Turns auto-merge on with a method, or off with null (`github auto-merge`). */
  setAutoMerge(root: string, number: number, method: GithubMergeMethod | null): Promise<void>
  /** Runs the checks again, only the failed ones when failedOnly (`github rerun-checks`). */
  rerunChecks(root: string, number: number, failedOnly: boolean): Promise<void>
  /** Marks a file viewed or not (`github file-viewed`). */
  setFileViewed(root: string, number: number, path: string, viewed: boolean): Promise<void>
  /** Submits a review with its inline comments (`github review`); rejects with gh's message. */
  submitReview(root: string, number: number, review: GithubReview): Promise<void>
  /** Adds a comment to a pull request's or an issue's conversation (`github comment`). */
  addComment(root: string, number: number, body: string): Promise<void>
  /** Closes or reopens an issue (`github issue-state`). */
  setIssueState(root: string, number: number, state: 'open' | 'closed', reason?: 'completed' | 'not planned'): Promise<void>
  /** Merges, closes or reopens a pull request (`github pr-state`). */
  setPrState(root: string, number: number, action: 'merge' | 'close' | 'reopen', options?: { method?: GithubMergeMethod }): Promise<void>
  /** Ask the person for a folder with the native picker, opening at defaultPath when given; null when cancelled. */
  pickFolder(defaultPath?: string): Promise<string | null>
  /** The system clipboard: text, and images as PNG bytes. */
  copyText(text: string): Promise<void>
  pasteText(): Promise<string>
  copyImage(png: Uint8Array): Promise<void>
  /** The clipboard's image as a PNG file; null when it holds none. */
  pasteImage(): Promise<File | null>
  /** Writes an image where the person picks in the save dialog; false when they cancel. */
  saveImageAs(bytes: Uint8Array, name: string): Promise<boolean>
  /** A chat's conversation; pass the last cursor to get only newer events. */
  transcript(target: { dispatchId: string } | { sessionId: string }, since?: string): Promise<Transcript>
  /** Read-only code browsing inside a worktree or repository megabrain lists. */
  codeTree(root: string): Promise<CodeEntry[]>
  codeRead(root: string, path: string): Promise<CodeFile>
  codeChanges(root: string): Promise<CodeChange[]>
  codeDiff(root: string, path: string): Promise<CodeDiff>
  /** The files the branch committed since its merge base with `parent` (or origin's default branch). */
  codeBranchChanges(root: string, parent: string | null): Promise<BranchChanges>
  /** One file at the merge base beside HEAD's version. */
  codeBranchDiff(root: string, mergeBase: string, path: string): Promise<CodeDiff>
  /** Native chats (megabrain chat ...). */
  chats(): Promise<NativeChat[]>
  startChat(options: { agent: string; model?: string; effort?: string; cwd: string; parts?: MessagePart[] }): Promise<NativeChat>
  /** `fresh` starts a new agent session when a suspended chat cannot resume its recorded one. While a turn runs the message waits in the chat's queue and `queued` is it. */
  sendChat(chatId: string, parts: MessagePart[], options?: { fresh?: boolean }): Promise<{ queued: ChatQueueItem | null }>
  /** A new chat holding this conversation through the turn of eventId (`chat fork --at`). */
  forkChat(chatId: string, eventId: string): Promise<NativeChat>
  /** Rewinds the last person message and answer, then sends the replacement (`chat edit-last`). */
  editLastMessage(chatId: string, parts: MessagePart[]): Promise<NativeChat>
  /** Rechecks a refused session resume and starts the existing session when its holder is gone. */
  resumeChat(chatId: string): Promise<void>
  /** Reads or changes a native chat's queue (`chat queue`); answers with the queue after the change. */
  chatQueue(chatId: string, change: ChatQueueChange): Promise<ChatQueueItem[]>
  interruptChat(chatId: string): Promise<void>
  answerApproval(chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny'): Promise<void>
  stopChat(chatId: string): Promise<void>
  /** Stops the chat if it runs and deletes it from megabrain; the agent's own session stays resumable. */
  removeChat(chatId: string): Promise<void>
  /** Switches the model, and optionally the reasoning effort, for the chat's next turns. */
  setChatModel(chatId: string, model: string, effort?: string): Promise<void>
  /** Summarizes a native chat now, whatever the schedule (`chat summarize <id> --json`). */
  summarizeChat(chatId: string): Promise<void>
  /** Each project's knowledge topics (`knowledge list --json`), or one repository's. */
  knowledge(repo?: string): Promise<KnowledgeList>
  /** Topics matching the text, best first (`knowledge search`). */
  searchKnowledge(text: string, repo?: string): Promise<KnowledgeSearch>
  /** One topic in full, with the chats that built it (`knowledge show <id>`). */
  knowledgeTopic(id: string): Promise<KnowledgeTopic>
  /** A chat's distilled transcript (`knowledge transcript <chat-id>`). */
  knowledgeTranscript(chatId: string): Promise<KnowledgeTranscript>
  /** Artifacts newest change first, of one project (its path) or topic (`artifact list --json`). */
  artifacts(options?: { project?: string; topic?: string }): Promise<ArtifactList>
  /** One artifact with its content, or an earlier revision's, and the revisions its updates replaced (`artifact show <id> [--revision <n>] --json`). */
  artifact(id: string, revision?: number): Promise<ArtifactContent>
  /** A native chat's artifacts, newest change first (`chat artifacts <chat-id> --json`). */
  chatArtifacts(chatId: string): Promise<ChatArtifactList>
  /** One of a chat's artifacts with its content, or an earlier revision's (`chat artifact <chat-id> <artifact-id> [--revision <n>] --json`). */
  chatArtifact(chatId: string, artifactId: string, revision?: number): Promise<ChatArtifactContent>
  /** Hand the conversation to the other side when the agent is idle; terminal mode returns the terminal to attach. */
  setChatMode(chatId: string, mode: 'chat' | 'terminal'): Promise<{ chat: NativeChat; terminal: TerminalSession | null; command: string[] | null }>
  /** The chat takes the session back from the agent's TUI; the daemon checks the terminal is idle, ends it and resumes. Refuses with terminal-busy mid-turn. */
  takeOverChat(chatId: string): Promise<NativeChat>
  /** The argv that resumes this chat in the agent's own TUI, for the embedded terminal. */
  chatTerminalCommand(chatId: string): Promise<string[]>
  /** Each agent's default model and effort from its own config, and the login shell's name (`agent defaults`). */
  agentDefaults(): Promise<AgentDefaults>
  /** The argv that starts an agent's own interactive TUI, prompts skipped (`agent command`), or resumes one of its sessions; rejects when its CLI is not installed. */
  agentCommand(agent: string, options?: { resume?: string; model?: string; effort?: string }): Promise<string[]>
  /** The effective start argv with no model, effort or resume, and the built-in one a typed command replaces. */
  agentStartCommand(agent: string): Promise<{ argv: string[]; builtin: string[] }>
  /** Past sessions started in a folder, newest first, from each agent's own storage (`sessions history`). */
  sessionHistory(cwd: string, agent?: string): Promise<HistorySession[]>
  /** Live events from cursor on; returns a function that stops the subscription. onEnd fires once if the follow ends without being stopped. */
  followChat(chatId: string, since: string | null, onLine: (line: ChatEventLine) => void, onEnd?: (error: string | null) => void): Promise<() => void>
  /** The chat as chatd holds it now, without following: its head line (chat and queue) and every stored line after the cursor. */
  chatEvents(chatId: string, since: string | null): Promise<ChatEventLine[]>
  /** The running chatd as it reports itself (`chat daemon status`); never starts one. */
  chatDaemonStatus(): Promise<ChatDaemonStatus>
  /** Asks an older chatd to exit by itself once every chat is idle; it keeps serving until then (`chat daemon retire`). */
  chatDaemonRetire(): Promise<{ running: false } | { running: true; retired: true; waitedMs: number }>
  /** Stops chatd once its running turns finish; queued messages wait for the next daemon (`chat daemon drain`). */
  chatDaemonDrain(): Promise<void>
  /** Appends one chat/terminal switch timing record to <state>/logs/desktop-switch.log. */
  logSwitchTrace(record: object): Promise<void>
  /** Appends one chat start trace line to <state>/logs/desktop-chat-start.log. */
  logChatStartTrace(record: object): Promise<void>
  /** Appends one render error an error boundary caught to <state>/logs/desktop-errors.log. */
  logError(record: object): Promise<void>
  /** Embedded terminals (native Tauri commands). */
  /** `chatId` names the chat whose terminal mode this is, so its TUI stays that chat's conversation. */
  openTerminal(options: { engine: TerminalEngine; cwd: string; command?: string[]; tmuxSession?: string; chatId?: string; cols: number; rows: number }): Promise<TerminalSession>
  writeTerminal(terminalId: string, data: string): Promise<void>
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>
  /** Closing kills the terminal for good. `kill` also reaches a terminal the app lists but does not hold open. */
  closeTerminal(terminalId: string, options?: { kill?: boolean }): Promise<void>
  /** The terminals the app left running on its tmux server, for a layout to bring back after a restart. */
  listAppTerminals(): Promise<AppTerminalListing[]>
  /** Bytes from the terminal, base64; returns a function that stops listening. */
  onTerminalData(terminalId: string, onData: (base64: string) => void, onExit: (code: number | null) => void): Promise<() => void>
  setTerminalEngine(engine: TerminalEngine): Promise<void>
  /** The sidebar's folders as saved (`settings get sidebar-folders`); advanced/sidebar-folders.ts reads the shape. */
  sidebarFolders(): Promise<unknown>
  /** Replaces the saved sidebar folders with this JSON (`settings set sidebar-folders`). */
  setSidebarFolders(json: string): Promise<void>
  /** What the sidebar folded and its row order, as `settings get sidebar-state` prints them. */
  sidebarState(): Promise<unknown>
  setSidebarState(json: string): Promise<void>
  /** The order and hidden providers of the sidebar's usage readout (`settings get usage-order`); advanced/usage-order.ts reads the shape. */
  usageOrder(): Promise<unknown>
  setUsageOrder(json: string): Promise<void>
  /** Who summarizes native chats and how often (`settings get chat-summaries`); settings/summaries-model.ts reads the shape. */
  chatSummaries(): Promise<unknown>
  setChatSummaries(json: string): Promise<void>
  /** Which projects the knowledge base reads (`settings get knowledge`); settings/knowledge-model.ts reads the shape. */
  knowledgeSettings(): Promise<unknown>
  setKnowledgeSettings(json: string): Promise<void>
  /** The default agent for New chat and the agents turned off for the app (`settings get agents`); settings/agents-model.ts reads the shape. */
  agentSettings(): Promise<unknown>
  setAgentSettings(json: string): Promise<void>
  /** Each agent CLI's installed and latest version and its last update attempt; settings/agent-updates-model.ts reads it. */
  agentUpdates(): Promise<AgentUpdates>
  /** Runs the agent's official installer now and reports the version it left installed. */
  agentUpdate(agent: string): Promise<Pick<AgentUpdateEntry, 'agent' | 'installed'>>
  /** Whether megabrain updates agents on its own (`settings get agents-update`); settings/agent-updates-model.ts reads the shape. */
  agentUpdateSettings(): Promise<unknown>
  setAgentUpdateSettings(json: string): Promise<void>
  /** The models turned on or off and each agent's default (`settings get models`); settings/models-model.ts reads the shape. */
  modelSettings(): Promise<unknown>
  setModelSettings(json: string): Promise<void>
  /** Where new worktrees are created (`settings get worktree-location`); settings/worktrees-model.ts reads the shape. */
  worktreeLocation(): Promise<unknown>
  setWorktreeLocation(json: string): Promise<void>
  /** The shortcut keys the person changed (`settings get shortcuts`); lib/shortcuts.ts reads the shape. */
  shortcuts(): Promise<unknown>
  setShortcuts(json: string): Promise<void>
}

/** Worktree creation (`worktree create`); kept apart from DesktopApi so its adapters live in worktree-create.ts. */
export interface WorktreeApi {
  /**
   * Creates a worktree on a new branch from a base ref; rejects with megabrain's error, as when the
   * branch exists. `stacked` records the base, another worktree's branch, as the new branch's parent.
   */
  createWorktree(repo: string, branch: string, base: string, stacked?: boolean): Promise<{ path: string; branch: string }>
}

/** What the app's `api` offers. */
export type AppApi = DesktopApi & WorktreeApi

/** A field left out stays as it is; null returns it to what megabrain detects. */
export type ProjectAppearancePatch = { [K in 'name' | 'color' | 'picture']?: string | null }

/** One tmux terminal the app opened: `id` is what `closeTerminal` takes, `sessionName` what a reopen attaches to. */
export type AppTerminalListing = { id: string; sessionName: string; cwd: string; title: string; command: string; alive: boolean; createdAt: string; chatId?: string | null }

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly refusalCode?: string,
  ) {
    super(message)
  }
}
