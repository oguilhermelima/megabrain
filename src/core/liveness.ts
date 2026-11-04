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

/** Startup dialogs block readiness until a person resolves them. */
export function startupDialogCause(agentId: string, output: string): string | undefined {
  if (agentId === "codex" && /(?:update available[\s\S]{0,300}(?:skip|install|update)|codex just got an upgrade)/i.test(output)) return "codex-update";
  const checks: readonly [RegExp, string][] = [
    [/do you trust[\s\S]{0,500}(?:workspace|folder|directory|project|repo)|trust this (?:workspace|folder|directory|project|repo)|trusted workspace/i, "workspace-trust-dialog"],
    [/(?:hooks need review|review (?:the )?hooks?|hooks? (?:require|need) approval)/i, "hook-review-dialog"],
    [/update available[\s\S]{0,300}(?:skip|install|update)|codex just got an upgrade/i, "update-dialog"],
    [/(?:permission required|requires permission|allow once[\s\S]{0,250}(?:allow always|reject|deny)|do you want to allow)/i, "permission-dialog"],
    [/(?:would you like to (?:continue|proceed|allow|choose)|what would you like to|which (?:option|one|approach)|select an option)[\s\S]{0,300}(?:\?|\b1\.|\b2\.|\byes\b|\bno\b)/i, "question-dialog"],
  ];
  return checks.find(([pattern]) => pattern.test(output))?.[1];
}

export async function waitForStableIdle(
  agentId: string,
  timeoutMs: number,
  read: () => Promise<Result<string>>,
  timeoutError: string,
  _answerFirstRunDialog?: () => Promise<Result<void>>,
  // A frame this accepts ends the wait at once: the agent already took a prompt from its argv.
  turnStarted?: (frame: string) => boolean,
): Promise<Result<void>> {
  const started = Date.now();
  let stableSince: number | null = null;
  while (true) {
    const captured = await read();
    // Dialogs belong to the person at the terminal. Keep observing; a dismissed dialog can
    // transition directly to the agent composer without any input from this process.
    if (captured.kind === "ok" && turnStarted?.(captured.value) === true) return ok(undefined);
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
