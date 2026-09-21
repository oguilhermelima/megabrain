import { getAgent } from "../agents/index.js";
import { LIVENESS_UNAVAILABLE, type Liveness, type LivenessResult } from "../agents/types.js";

export type { Liveness, LivenessResult } from "../agents/types.js";

export function classifyLiveness(agent: string, output: string): LivenessResult {
  const strategy = getAgent(agent);
  if (strategy === undefined) return { status: "unknown", reason: null };
  const result = strategy.classifyLiveness(output);
  if (result.kind === "ok") return result.value;
  if (result.kind === "unknown" && result.reason.startsWith(`${LIVENESS_UNAVAILABLE}:`)) return { status: "unknown", reason: null };
  if (result.kind === "unknown") return { status: "unknown", reason: null };
  return { status: "unknown", reason: null };
}
