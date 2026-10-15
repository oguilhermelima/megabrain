import type { CodeServer, SendResult, AdmissionPolicy, Chain, Settings, GithubRepository, Project, Repository, ChatRead, CodeChange, CodeDiff, CodeEntry, CodeFile, DoctorReport, InstallEvent, InstallPlan, ModuleResult, ReplyResult, Status, Transcript, Worktree } from '@/api/schema'

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
  pillGeometry(): Promise<PillGeometry>
  setPillExpanded(expanded: boolean): Promise<void>
  onPillExpanded(listener: (expanded: boolean) => void): () => void
  openMain(): Promise<void>
  /** Send a message to any agent session, as the operator. */
  sendToSession(sessionId: string, text: string): Promise<SendResult>
  /** A local VS Code for a worktree or repository; started on demand and reused. */
  openCodeServer(root: string): Promise<CodeServer>
  stopCodeServer(root: string): Promise<void>
  /** Everything the Settings window shows. */
  settings(): Promise<Settings>
  /** Set the admission policy; null turns it off. */
  setPolicy(policy: AdmissionPolicy | null): Promise<void>
  setResourceHistory(enabled: boolean): Promise<void>
  setSupervisor(running: boolean): Promise<void>
  setLimitNotice(enabled: boolean, intervalSeconds?: number): Promise<void>
  setLimitProvider(provider: string, enabled: boolean): Promise<void>
  /** Create or replace a chain. */
  saveChain(chain: Chain): Promise<void>
  deleteChain(name: string): Promise<void>
  refreshModels(agent: string): Promise<void>
  /** null clears the default. */
  setTerminalDefault(name: string | null): Promise<void>
  /** Every registered project, its worktrees and the agent sessions in them. */
  projects(): Promise<Project[]>
  /** Import a local git repository folder into the registry. */
  importFolder(path: string): Promise<Repository>
  /** Clone a repository and register it; `into` is the parent folder. */
  importClone(url: string, into: string): Promise<Repository>
  /** Repositories on GitHub the person can clone. */
  githubRepositories(): Promise<GithubRepository[]>
  /** Ask the person for a folder with the native picker; null when cancelled. */
  pickFolder(): Promise<string | null>
  /** A chat's conversation; pass the last cursor to get only newer events. */
  transcript(target: { dispatchId: string } | { sessionId: string }, since?: string): Promise<Transcript>
  /** Read-only code browsing inside a worktree or repository megabrain lists. */
  codeTree(root: string): Promise<CodeEntry[]>
  codeRead(root: string, path: string): Promise<CodeFile>
  codeChanges(root: string): Promise<CodeChange[]>
  codeDiff(root: string, path: string): Promise<CodeDiff>
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
  }
}
