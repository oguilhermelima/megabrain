import { failed, ok, type Result } from "./result.js";
import type { ContextMeter } from "./context-meter.js";

export type ContextPolicy = Readonly<{
  readonly contextCeiling?: number;
  readonly compactAt?: number;
  readonly loop?: boolean;
  readonly maxIterations?: number;
}>;

export type ContextThresholdState = Readonly<{
  readonly ceilingLatched: boolean;
  readonly compactLatched: boolean;
}>;

export type ContextActionRecord = Readonly<{
  readonly action: "stop" | "compact";
  readonly percentUsed: number;
  readonly sourceFrame: string;
}>;

export type ContextThresholdDecision = Readonly<{
  readonly action: "stop" | "compact" | "none";
  readonly state: ContextThresholdState;
  readonly record: ContextActionRecord | null;
}>;

export function validateContextPolicy(policy: ContextPolicy): Result<void> {
  for (const [name, value] of [["--context-ceiling", policy.contextCeiling], ["--compact-at", policy.compactAt]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
      return failed(`${name} must be a percentage from 0 to 100`, 2);
    }
  }
  if (policy.maxIterations !== undefined && (!Number.isSafeInteger(policy.maxIterations) || policy.maxIterations < 1)) {
    return failed("--max-iterations must be a positive whole number", 2);
  }
  if (policy.maxIterations !== undefined && policy.loop !== true) return failed("--max-iterations requires --loop", 2);
  if (policy.loop === true && policy.maxIterations === undefined && policy.contextCeiling === undefined) {
    return failed("--loop requires --max-iterations or --context-ceiling", 2);
  }
  if (policy.contextCeiling !== undefined && policy.compactAt !== undefined && policy.compactAt >= policy.contextCeiling) {
    return failed("--compact-at must be below --context-ceiling", 2);
  }
  return ok(undefined);
}

export function evaluateContextThreshold(
  policy: ContextPolicy,
  state: ContextThresholdState,
  meter: ContextMeter,
): ContextThresholdDecision {
  if (meter.status === "unknown") return { action: "none", state, record: null };
  const next: ContextThresholdState = {
    ceilingLatched: policy.contextCeiling === undefined || meter.percentUsed < policy.contextCeiling ? false : state.ceilingLatched,
    compactLatched: policy.compactAt === undefined || meter.percentUsed < policy.compactAt ? false : state.compactLatched,
  };
  if (policy.contextCeiling !== undefined && meter.percentUsed >= policy.contextCeiling && !state.ceilingLatched) {
    return {
      action: "stop",
      state: { ...next, ceilingLatched: true },
      record: { action: "stop", percentUsed: meter.percentUsed, sourceFrame: meter.sourceFrame },
    };
  }
  if (policy.compactAt !== undefined && meter.percentUsed >= policy.compactAt && !state.compactLatched) {
    return {
      action: "compact",
      state: { ...next, compactLatched: true },
      record: { action: "compact", percentUsed: meter.percentUsed, sourceFrame: meter.sourceFrame },
    };
  }
  return { action: "none", state: next, record: null };
}

export function decideLoopTurn(
  done: boolean,
  completedIterations: number,
  maxIterations: number | undefined,
): Readonly<{ action: "done" | "stop" | "continue"; completedIterations: number }> {
  if (done) return { action: "done", completedIterations };
  if (maxIterations !== undefined && completedIterations >= maxIterations) return { action: "stop", completedIterations };
  return { action: "continue", completedIterations };
}
