import type { DoctorReport, InstallEvent, InstallPlan, ModuleResult, Status } from '@/api/schema'

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
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
  }
}
