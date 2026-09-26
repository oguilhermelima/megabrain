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

export function isFirstRunDialog(agentId: string, output: string): boolean {
  const dialog = getAgent(agentId)?.firstRunDialog;
  return dialog?.test(output) ?? false;
}

export async function waitForStableIdle(
  agentId: string,
  timeoutMs: number,
  read: () => Promise<Result<string>>,
  timeoutError: string,
  answerFirstRunDialog?: () => Promise<Result<void>>,
): Promise<Result<void>> {
  const started = Date.now();
  let stableSince: number | null = null;
  let firstRunDialogAnswered = false;
  while (true) {
    const captured = await read();
    const dialog = captured.kind === "ok" && isFirstRunDialog(agentId, captured.value);
    if (dialog && answerFirstRunDialog !== undefined && !firstRunDialogAnswered) {
      firstRunDialogAnswered = true;
      const answered = await answerFirstRunDialog();
      if (answered.kind !== "ok") return answered;
    }
    const idle = captured.kind === "ok" && !dialog && classifyLiveness(agentId, captured.value).status === "idle";
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
