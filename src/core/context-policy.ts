import { failed, ok, type Result } from "./result.js";
import type { ContextMeter } from "./context-meter.js";

export type ContextPolicy = Readonly<{
  readonly contextCeiling?: number;
  readonly contextCeilingTokens?: number;
  readonly compactAt?: number;
  readonly compactAtTokens?: number;
  readonly loop?: boolean;
  readonly maxIterations?: number;
}>;

export type ContextThresholdState = Readonly<{
  readonly ceilingLatched: boolean;
  readonly compactLatched: boolean;
}>;

export type ContextActionRecord = Readonly<{
  readonly action: "stop" | "compact";
  readonly percentUsed: number | null;
  readonly usedTokens: number;
  readonly sourceFrame: string;
}>;

export type ContextThreshold = Readonly<{ unit: "percent" | "tokens"; amount: number }>;

export type ContextThresholdDecision = Readonly<{
  readonly action: "stop" | "compact" | "none";
  readonly state: ContextThresholdState;
  readonly record: ContextActionRecord | null;
}>;

/** `80%` is a share of the window; `150k`, `1m` or a bare number above 100 is an absolute token count. */
export function parseContextThreshold(value: string): Result<ContextThreshold> {
  const text = value.trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (percent !== null) {
    const amount = Number(percent[1]);
    return amount > 0 && amount <= 100 ? ok({ unit: "percent", amount }) : failed(`${value} is not a percentage above 0 and up to 100`, 2);
  }
  const suffixed = /^(\d+(?:\.\d+)?)([km])$/i.exec(text);
  if (suffixed !== null) {
    const amount = Math.round(Number(suffixed[1]) * (suffixed[2].toLowerCase() === "k" ? 1_000 : 1_000_000));
    return amount > 0 ? ok({ unit: "tokens", amount }) : failed(`${value} is not a positive token count`, 2);
  }
  if (/^\d+$/.test(text)) {
    const amount = Number(text);
    return amount > 100 && Number.isSafeInteger(amount)
      ? ok({ unit: "tokens", amount })
      : failed(`${value} is ambiguous: write ${text}% for a percentage or ${text}k for tokens`, 2);
  }
  return failed(`${value} is not a threshold: use N% or a token count such as 150k, 1m or 150000`, 2);
}

/** Policy fields for a parsed threshold: percentages keep the original field, tokens get a sibling. */
export function thresholdFields(name: "contextCeiling" | "compactAt", threshold: ContextThreshold): ContextPolicy {
  return threshold.unit === "percent" ? { [name]: threshold.amount } : { [`${name}Tokens`]: threshold.amount };
}

export const hasCompactThreshold = (policy: ContextPolicy): boolean => policy.compactAt !== undefined || policy.compactAtTokens !== undefined;
export const hasCeilingThreshold = (policy: ContextPolicy): boolean => policy.contextCeiling !== undefined || policy.contextCeilingTokens !== undefined;

export function validateContextPolicy(policy: ContextPolicy): Result<void> {
  const pairs = [
    ["--context-ceiling", policy.contextCeiling, policy.contextCeilingTokens],
    ["--compact-at", policy.compactAt, policy.compactAtTokens],
  ] as const;
  for (const [name, percent, tokens] of pairs) {
    if (percent !== undefined && tokens !== undefined) return failed(`${name} takes a percentage or a token count, not both`, 2);
    if (percent !== undefined && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
      return failed(`${name} must be a percentage above 0 and up to 100`, 2);
    }
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
      return failed(`${name} must be a positive token count`, 2);
    }
  }
  if (policy.maxIterations !== undefined && (!Number.isSafeInteger(policy.maxIterations) || policy.maxIterations < 1)) {
    return failed("--max-iterations must be a positive whole number", 2);
  }
  if (policy.maxIterations !== undefined && policy.loop !== true) return failed("--max-iterations requires --loop", 2);
  const hasCeiling = policy.contextCeiling !== undefined || policy.contextCeilingTokens !== undefined;
  if (policy.loop === true && policy.maxIterations === undefined && !hasCeiling) {
    return failed("--loop requires --max-iterations or --context-ceiling", 2);
  }
  const compactBelowCeiling = (compact: number | undefined, ceiling: number | undefined) => compact === undefined || ceiling === undefined || compact < ceiling;
  if (!compactBelowCeiling(policy.compactAt, policy.contextCeiling) || !compactBelowCeiling(policy.compactAtTokens, policy.contextCeilingTokens)) {
    return failed("--compact-at must be below --context-ceiling", 2);
  }
  return ok(undefined);
}

/** True or false when the meter can compare against the threshold; undefined when it lacks the unit (unknown is never low). */
function reached(meter: Extract<ContextMeter, { status: "known" }>, percent: number | undefined, tokens: number | undefined): boolean | undefined {
  if (tokens !== undefined) return meter.usedTokens >= tokens;
  if (percent !== undefined && meter.percentUsed !== undefined) return meter.percentUsed >= percent;
  return undefined;
}

export function evaluateContextThreshold(
  policy: ContextPolicy,
  state: ContextThresholdState,
  meter: ContextMeter,
): ContextThresholdDecision {
  if (meter.status === "unknown") return { action: "none", state, record: null };
  const ceilingReached = reached(meter, policy.contextCeiling, policy.contextCeilingTokens);
  const compactReached = reached(meter, policy.compactAt, policy.compactAtTokens);
  const ceilingSet = policy.contextCeiling !== undefined || policy.contextCeilingTokens !== undefined;
  const compactSet = policy.compactAt !== undefined || policy.compactAtTokens !== undefined;
  const next: ContextThresholdState = {
    ceilingLatched: !ceilingSet || ceilingReached === false ? false : state.ceilingLatched,
    compactLatched: !compactSet || compactReached === false ? false : state.compactLatched,
  };
  const record = (action: "stop" | "compact"): ContextActionRecord => ({
    action,
    percentUsed: meter.percentUsed ?? null,
    usedTokens: meter.usedTokens,
    sourceFrame: meter.sourceFrame,
  });
  if (ceilingReached === true && !state.ceilingLatched) {
    return { action: "stop", state: { ...next, ceilingLatched: true }, record: record("stop") };
  }
  if (compactReached === true && !state.compactLatched) {
    return { action: "compact", state: { ...next, compactLatched: true }, record: record("compact") };
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
