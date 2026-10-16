import { ok, unknown, type Result } from "../core/result.js";

export type Liveness = "working" | "idle" | "blocked" | "pending-check" | "unknown" | "missing";
export type LivenessResult = Readonly<{ status: Liveness; reason: string | null }>;
export type SubmitKey = "Enter" | "Tab";
export type InterruptKey = "Escape" | "C-c";
export type AgentCommandOptions = Readonly<{
  readonly model: string | null;
  readonly effort: string | null;
  readonly browser: boolean;
  readonly agentArgs: readonly string[];
}>;

// How an agent's CLI spells the flags every launch needs; spawn and the interactive TUI share it.
// `quote` wraps a value for a shell line (spawn) or leaves it raw for an argv.
export type Quote = (value: string) => string;
export type AgentFlags = Readonly<{
  readonly executable: string;
  readonly permission: readonly string[];
  readonly model: (value: string, quote: Quote) => readonly string[];
  readonly effort: ((value: string, quote: Quote) => readonly string[]) | null;
  // For a CLI that takes the effort as part of the model id instead of a flag of its own.
  readonly modelWithEffort?: (model: string, effort: string | null) => string;
  // How the agent's CLI resumes a session by id; `lead` goes right after the executable (a subcommand).
  readonly resume: (id: string, quote: Quote) => Readonly<{ lead: readonly string[]; trail: readonly string[] }>;
}>;

export type AgentMarker = Readonly<{
  readonly status: Exclude<Liveness, "unknown" | "missing">;
  readonly first: RegExp;
  readonly second?: RegExp;
  readonly reason: string;
}>;

export type Agent = Readonly<{
  readonly id: string;
  readonly matchesDescriptor: (descriptor: string) => boolean;
  readonly classifyLiveness: (output: string) => Result<LivenessResult>;
  readonly contextSource?: "codex-rollout" | "claude-transcript" | "grok-session";
  readonly compactCommand?: string;
  readonly firstRunDialog?: RegExp;
  // Key that answers the first-run dialog; Enter when absent.
  readonly firstRunDialogKey?: string;
  readonly flags?: AgentFlags;
  readonly commandLine?: (options: AgentCommandOptions) => Result<string>;
  // What precedes the initial interactive prompt on the command line, when the agent takes one.
  readonly initialPromptFlag?: string;
  readonly submitKey?: () => Result<SubmitKey>;
  readonly interruptKey?: () => Result<InterruptKey>;
}>;

export const LIVENESS_UNAVAILABLE = "liveness-unavailable";

export function unavailableKey(agent: string, operation: "submit" | "interrupt"): Result<never> {
  return unknown(`${operation}-key-unavailable: ${agent} has no ${operation} key`);
}

export function classifyMarkers(markers: readonly AgentMarker[], output: string): Result<LivenessResult> {
  for (const marker of markers) {
    if (marker.first.test(output) && (marker.second === undefined || marker.second.test(output))) {
      return ok({ status: marker.status, reason: marker.reason });
    }
  }
  return ok({ status: "unknown", reason: null });
}

export function unavailableLiveness(agent: string): Result<LivenessResult> {
  return unknown(`${LIVENESS_UNAVAILABLE}: ${agent} has no liveness markers`);
}

export function launchArgv(flags: AgentFlags, model: string | null, effort: string | null, quote: Quote, resume: string | null = null): string[] {
  const resumed = resume === null ? null : flags.resume(resume, quote);
  return [
    flags.executable,
    ...(resumed?.lead ?? []),
    ...flags.permission,
    ...(model === null ? [] : flags.model(flags.modelWithEffort?.(model, effort) ?? model, quote)),
    ...(effort === null || flags.effort === null ? [] : flags.effort(effort, quote)),
    ...(resumed?.trail ?? []),
  ];
}

export function rawValue(value: string): string {
  return value;
}

export function doubleQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`).replace(/\r?\n/g, "\\n")}"`;
}

export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+\-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
