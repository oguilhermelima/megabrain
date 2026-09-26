import { ok, unknown, type Result } from "../core/result.js";

export type Liveness = "working" | "idle" | "blocked" | "pending-check" | "unknown" | "missing";
export type LivenessResult = Readonly<{ status: Liveness; reason: string | null }>;
export type SubmitKey = "Enter" | "Tab";
export type InterruptKey = "Escape";
export type AgentCommandOptions = Readonly<{
  readonly model: string | null;
  readonly effort: string | null;
  readonly browser: boolean;
  readonly agentArgs: readonly string[];
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
  readonly firstRunDialog?: RegExp;
  readonly commandLine?: (options: AgentCommandOptions) => Result<string>;
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

export function doubleQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/g, (character) => `\\${character}`).replace(/\r?\n/g, "\\n")}"`;
}

export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+\-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
