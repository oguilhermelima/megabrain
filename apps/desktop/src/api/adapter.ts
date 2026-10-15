import type { ChatRead, DoctorReport, InstallEvent, InstallPlan, ModuleResult, ReplyResult, Status, Worktree } from '@/api/schema'

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
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
  }
}
