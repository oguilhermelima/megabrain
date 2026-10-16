import type { ProjectsOrigin } from '@/api/projects-origin'
import type { NativeChat, ChatEventLine, MessagePart, TerminalEngine, TerminalSession, GithubDetail, GithubMergeMethod, GithubPullRequestFile, GithubPullRequestFilesPage, GithubReview, GithubReviewThread, GithubReviewer, GithubReviewers, HistorySession, GithubIssueList, GithubPullRequestList, QueuedMessage, SlashCommand, StackShow, CodeServer, SendResult, AdmissionPolicy, Settings, GithubRepository, Project, ProjectAppearance, ProjectScripts, ArchivedWorktree, PortListeners, Repository, BranchChanges, ChatRead, CodeChange, CodeDiff, CodeEntry, CodeFile, DoctorReport, InstallEvent, InstallPlan, ModuleResult, ReplyResult, Status, Transcript, Worktree, ChainBody, ChainExplain, ChainExplainInput, ChainValidation, StepPatch } from '@/api/schema'

/** `~/.local/bin/megabrain` as the native side sees it (src-tauri/src/path_link.rs). */
export interface PathLink {
  linkPath: string
  kind: 'missing' | 'ours' | 'other-link' | 'file'
  pointsTo: string | null
  bundled: string
  dirOnPath: boolean
  resolvesTo: string | null
}

/** The notch of the main screen, in points; no notch on Linux or older Macs. */
export interface PillGeometry {
  notchWidth: number | null
  barHeight: number
}

export interface InstallExit {
  code: number | null
  stderr: string
}

/** Everything the UI may ask of megabrain. Implemented by the Tauri and mock adapters. */
export interface DesktopApi {
  readonly kind: 'tauri' | 'mock'
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
  /** A chat's recent output, as the operator (`orchestrate read --operator`). */
  readChat(dispatchId: string, lines: number): Promise<ChatRead>
  /** Sends a message into a chat, as the operator (`orchestrate reply --operator`). */
  reply(dispatchId: string, text: string): Promise<ReplyResult>
  /** The last message a chat's child sent, in full (`db show`); null when it sent none. */
  readDispatchMessage(dispatchId: string): Promise<string | null>
  pillGeometry(): Promise<PillGeometry>
  setPillExpanded(expanded: boolean): Promise<void>
  onPillExpanded(listener: (expanded: boolean) => void): () => void
  openMain(): Promise<void>
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
  /** Forget ownership and kill megabrain's tmux session for it (`session release`). */
  releaseSession(sessionId: string): Promise<void>
  /** Open an https address in the system's browser, or a mailto address in the mail app. */
  openUrl(url: string): Promise<void>
  /** Show a folder or file in Finder (the file manager on Linux). */
  revealPath(path: string): Promise<void>
  /** A local VS Code for a worktree or repository; started on demand and reused. */
  openCodeServer(root: string): Promise<CodeServer>
  stopCodeServer(root: string): Promise<void>
  /** Open a file (optionally at a line) in the running VS Code for that root; starts it when needed. */
  openInCode(root: string, path: string, line?: number): Promise<CodeServer>
  /** Everything the Settings window shows. */
  settings(): Promise<Settings>
  /** Set the admission policy; null turns it off. */
  setPolicy(policy: AdmissionPolicy | null): Promise<void>
  setResourceHistory(enabled: boolean): Promise<void>
  setSupervisor(running: boolean): Promise<void>
  setLimitNotice(enabled: boolean, intervalSeconds?: number): Promise<void>
  setLimitProvider(provider: string, enabled: boolean): Promise<void>
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
  /** Repositories on GitHub the person can clone. */
  githubRepositories(): Promise<GithubRepository[]>
  /** One page of a repository's pull requests through gh (`github prs`), after a cursor; the CLI caches each answer for 60 s. */
  githubPullRequests(root: string, state: 'open' | 'closed' | 'merged' | 'all', limit: number, after: string | null): Promise<GithubPullRequestList>
  /** One page of a repository's issues through gh (`github issues`). */
  githubIssues(root: string, state: 'open' | 'closed' | 'all', limit: number, after: string | null): Promise<GithubIssueList>
  /** One pull request's body, comments, checks, review decision and line counts (`github pr`). */
  githubPullRequest(root: string, number: number): Promise<GithubDetail>
  /** One issue's body and comments (`github issue`). */
  githubIssue(root: string, number: number): Promise<GithubDetail>
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
  /** Ask the person for a folder with the native picker; null when cancelled. */
  pickFolder(): Promise<string | null>
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
  startChat(options: { agent: string; model?: string; cwd: string; parts?: MessagePart[] }): Promise<NativeChat>
  /** `fresh` starts a new agent session when a suspended chat cannot resume its recorded one. */
  sendChat(chatId: string, parts: MessagePart[], options?: { fresh?: boolean }): Promise<void>
  interruptChat(chatId: string): Promise<void>
  answerApproval(chatId: string, approvalId: string, decision: 'allow' | 'allow-session' | 'deny'): Promise<void>
  stopChat(chatId: string): Promise<void>
  /** Stops the chat if it runs and deletes it from megabrain; the agent's own session stays resumable. */
  removeChat(chatId: string): Promise<void>
  /** Switches the model, and optionally the reasoning effort, for the chat's next turns. */
  setChatModel(chatId: string, model: string, effort?: string): Promise<void>
  /** Hand the conversation to the other side when the agent is idle; terminal mode returns the terminal to attach. */
  setChatMode(chatId: string, mode: 'chat' | 'terminal'): Promise<{ chat: NativeChat; terminal: TerminalSession | null; command: string[] | null }>
  /** The argv that resumes this chat in the agent's own TUI, for the embedded terminal. */
  chatTerminalCommand(chatId: string): Promise<string[]>
  /** The argv that starts an agent's own interactive TUI, prompts skipped (`agent command`), or resumes one of its sessions; rejects when its CLI is not installed. */
  agentCommand(agent: string, options?: { resume?: string; model?: string; effort?: string }): Promise<string[]>
  /** Past sessions started in a folder, newest first, from each agent's own storage (`sessions history`). */
  sessionHistory(cwd: string, agent?: string): Promise<HistorySession[]>
  /** Live events from cursor on; returns a function that stops the subscription. onEnd fires once if the follow ends without being stopped. */
  followChat(chatId: string, since: string | null, onLine: (line: ChatEventLine) => void, onEnd?: (error: string | null) => void): Promise<() => void>
  /** Appends one chat/terminal switch timing record to <state>/logs/desktop-switch.log. */
  logSwitchTrace(record: object): Promise<void>
  /** Embedded terminals (native Tauri commands). */
  openTerminal(options: { engine: TerminalEngine; cwd: string; command?: string[]; tmuxSession?: string; cols: number; rows: number }): Promise<TerminalSession>
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
export type AppTerminalListing = { id: string; sessionName: string; cwd: string; title: string; command: string; alive: boolean; createdAt: string }

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
  }
}
