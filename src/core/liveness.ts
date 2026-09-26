import { getAgent } from "../agents/index.js";
import { LIVENESS_UNAVAILABLE, type Liveness, type LivenessResult } from "../agents/types.js";
import { failed, ok, type Result } from "./result.js";

export const TMUX_READINESS_POLL_MS = 100;
export const TMUX_READINESS_STABLE_MS = 1000;

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

export function hasLivenessClassifier(agent: string): boolean {
  const strategy = getAgent(agent);
  if (strategy === undefined) return false;
  const result = strategy.classifyLiveness("");
  return result.kind !== "unknown" || !result.reason.startsWith(`${LIVENESS_UNAVAILABLE}:`);
}

export async function waitForStableIdle(
  agentId: string,
  timeoutMs: number,
  read: () => Promise<Result<string>>,
  timeoutError: string,
): Promise<Result<void>> {
  const started = Date.now();
  let stableSince: number | null = null;
  while (true) {
    const captured = await read();
    const idle = captured.kind === "ok" && classifyLiveness(agentId, captured.value).status === "idle";
    if (idle) {
      if (stableSince === null) stableSince = Date.now();
      else if (Date.now() - stableSince >= TMUX_READINESS_STABLE_MS) return ok(undefined);
    } else {
      stableSince = null;
    }
    if (Date.now() - started >= timeoutMs) return failed(timeoutError);
    await new Promise((resolve) => setTimeout(resolve, TMUX_READINESS_POLL_MS));
  }
}
