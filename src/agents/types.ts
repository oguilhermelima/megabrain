import { ok, unknown, type Result } from "../core/result.js";

export type Liveness = "working" | "idle" | "blocked" | "pending-check" | "unknown" | "missing";
export type LivenessResult = Readonly<{ status: Liveness; reason: string | null }>;

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
}>;

export const LIVENESS_UNAVAILABLE = "liveness-unavailable";

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
