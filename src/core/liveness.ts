import { getAgent } from "../agents/index.js";
import { LIVENESS_UNAVAILABLE, type Liveness, type LivenessResult } from "../agents/types.js";
import { failed, ok, type Result } from "./result.js";

export const TMUX_READINESS_POLL_MS = 100;
export const TMUX_READINESS_STABLE_MS = 1000;

export type { Liveness, LivenessResult } from "../agents/types.js";

export type ContextMeter = Readonly<
  | { readonly status: "known"; readonly percentUsed: number; readonly sourceFrame: string }
  | { readonly status: "unknown" }
>;

function tokenScale(unit: string | undefined): number {
  if (unit?.toLowerCase() === "k") return 1_000;
  if (unit?.toLowerCase() === "m") return 1_000_000;
  return 1;
}

export function readContextMeter(agent: string, output: string): ContextMeter {
  const patterns = getAgent(agent)?.contextMeterPatterns;
  if (patterns === undefined) return { status: "unknown" };
  const lines = output.split(/\r?\n/);
  for (const candidate of patterns) {
    for (const line of lines.toReversed()) {
      const match = candidate.pattern.exec(line);
      if (match === null || match.groups === undefined) continue;
      let percentUsed: number;
      if (candidate.reading === "percent-left") {
        const left = Number(match.groups.value);
        if (!Number.isFinite(left) || left < 0 || left > 100) continue;
        percentUsed = 100 - left;
      } else {
        const used = Number(match.groups.used) * tokenScale(match.groups.usedUnit);
        const total = Number(match.groups.total) * tokenScale(match.groups.totalUnit);
        if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) continue;
        percentUsed = (used / total) * 100;
      }
      if (!Number.isFinite(percentUsed) || percentUsed < 0) continue;
      return { status: "known", percentUsed: Math.round(percentUsed * 10) / 10, sourceFrame: line.trim() };
    }
  }
  return { status: "unknown" };
}

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
