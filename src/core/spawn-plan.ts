import { checkDispatchTransition, type DispatchAxis, type DispatchStateValue, type ProcessStateValue, type TerminalStateValue } from "./dispatch-states.js";
import { ok, unknown, type Result } from "./result.js";

export const spawnFailureReasons = {
  "prompt-publication": "prompt-publication-failed",
  "command-submission": "command-not-submitted",
  "readiness-wait": "readiness-timeout",
  "readiness-output-validation": "readiness-output-invalid",
  "prompt-transport": "prompt-transport-failed",
  "prompt-confirmation": "prompt-confirmation-failed",
  "transcript-start": "transcript-start-failed",
  "state-persist": "state-persist-failed",
  "metadata-read-before-command": "metadata-read-failed",
  "metadata-read-after-readiness": "metadata-read-failed",
  "model-substitution-record": "model-substitution-record-failed",
  "prompt-state-persist": "prompt-state-persist-failed",
} as const;

export type SpawnReason = typeof spawnFailureReasons[keyof typeof spawnFailureReasons];
export type SpawnRuntime = "tmux" | "host";
export type WorktreeOwnership = "created" | "existing" | "unknown";

export type SpawnStep = keyof typeof spawnFailureReasons;

export type SpawnState = {
  readonly dispatch: DispatchStateValue;
  readonly process: ProcessStateValue;
  readonly terminal: TerminalStateValue;
};

export type SpawnStepOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed" }
  | { readonly kind: "prompt-transport"; readonly status: "delivered" | "awaiting-receipt" | "failed" };

type PromptTransportStatus = Extract<SpawnStepOutcome, { readonly kind: "prompt-transport" }>["status"];

export type SpawnDecisionInput = {
  readonly dispatchId: string;
  readonly runtime: SpawnRuntime;
  readonly worktree: WorktreeOwnership;
  readonly state: SpawnState;
  readonly step: SpawnStep;
  readonly outcome: SpawnStepOutcome;
};

export type SpawnCleanup =
  | { readonly kind: "none" }
  | { readonly kind: "required"; readonly runtime: SpawnRuntime; readonly worktree: "remove" | "preserve" };

export type SpawnPlan = {
  readonly action: "continue" | "await-receipt" | "fail";
  readonly nextStep: SpawnStep | null;
  readonly state: SpawnState;
  readonly reason: SpawnReason | null;
  readonly cleanup: SpawnCleanup;
  readonly exitCode: 0 | 1;
  readonly lifecycle: "open";
  readonly reconcile: { readonly instruction: string } | null;
};

const tmuxOnlySteps: readonly SpawnStep[] = [
  "transcript-start",
  "model-substitution-record",
  "readiness-output-validation",
];

const hostOnlySteps: readonly SpawnStep[] = [
  "readiness-wait",
  "metadata-read-before-command",
  "metadata-read-after-readiness",
];

function stepBelongsToRuntime(runtime: SpawnRuntime, step: SpawnStep): boolean {
  if (tmuxOnlySteps.includes(step)) return runtime === "tmux";
  if (hostOnlySteps.includes(step)) return runtime === "host";
  return true;
}

function transitionState(before: SpawnState, after: SpawnState): Result<SpawnState> {
  const axes: readonly DispatchAxis[] = ["dispatch", "process", "terminal"];
  for (const axis of axes) {
    const transition = checkDispatchTransition(axis, before[axis], after[axis]);
    if (transition.kind === "unknown") return transition;
    if (transition.kind === "failed") {
      return unknown(`spawn plan cannot make ${axis} transition ${before[axis]} -> ${after[axis]}`);
    }
  }
  return ok(after);
}

function failureCleanup(runtime: SpawnRuntime, worktree: WorktreeOwnership): Result<SpawnCleanup> {
  if (worktree === "unknown") return unknown("worktree ownership cannot be determined for launch cleanup");
  return ok({ kind: "required", runtime, worktree: worktree === "created" ? "remove" : "preserve" });
}

function nextStep(runtime: SpawnRuntime, step: SpawnStep, status?: SpawnStepOutcome["kind"] | PromptTransportStatus): SpawnStep | null {
  switch (step) {
    case "transcript-start":
      return "prompt-publication";
    case "prompt-publication":
      return runtime === "tmux" ? "command-submission" : "metadata-read-before-command";
    case "metadata-read-before-command":
      return "command-submission";
    case "command-submission":
      return runtime === "tmux" ? "model-substitution-record" : "readiness-wait";
    case "model-substitution-record":
      return "readiness-output-validation";
    case "readiness-output-validation":
      return "prompt-transport";
    case "readiness-wait":
      return "metadata-read-after-readiness";
    case "metadata-read-after-readiness":
      return "prompt-transport";
    case "prompt-transport":
      if (status === "delivered") return "prompt-confirmation";
      if (status === "awaiting-receipt") return "prompt-state-persist";
      return null;
    case "prompt-confirmation":
      return "state-persist";
    case "state-persist":
    case "prompt-state-persist":
      return null;
  }
}

function isPromptTransportOutcome(outcome: SpawnStepOutcome): outcome is Extract<SpawnStepOutcome, { readonly kind: "prompt-transport" }> {
  return outcome.kind === "prompt-transport";
}

function planFailure(input: SpawnDecisionInput, reason: SpawnReason): Result<SpawnPlan> {
  const cleanup = failureCleanup(input.runtime, input.worktree);
  if (cleanup.kind !== "ok") return cleanup;
  const state = transitionState(input.state, {
    dispatch: "failed",
    process: "failed",
    terminal: "released",
  });
  if (state.kind !== "ok") return state;
  const plan: SpawnPlan = {
    action: "fail",
    nextStep: null,
    state: state.value,
    reason,
    cleanup: cleanup.value,
    exitCode: 1,
    lifecycle: "open",
    reconcile: null,
  };
  return ok(plan, plan.exitCode);
}

function planSuccess(input: SpawnDecisionInput, status?: SpawnStepOutcome["kind"] | PromptTransportStatus): Result<SpawnPlan> {
  const isAwaitingReceipt = input.step === "prompt-transport" && status === "awaiting-receipt" || input.step === "prompt-state-persist";
  const isRunning = input.step === "state-persist";
  const nextState = isRunning
    ? { dispatch: "running", process: "running", terminal: input.state.terminal } satisfies SpawnState
    : input.state;
  const state = transitionState(input.state, nextState);
  if (state.kind !== "ok") return state;
  const plan: SpawnPlan = {
    action: isAwaitingReceipt ? "await-receipt" : "continue",
    nextStep: nextStep(input.runtime, input.step, status),
    state: state.value,
    reason: null,
    cleanup: { kind: "none" },
    exitCode: 0,
    lifecycle: "open",
    reconcile: isAwaitingReceipt ? { instruction: `megabrain orchestrate reconcile ${input.dispatchId}` } : null,
  };
  return ok(plan, plan.exitCode);
}

export function decideSpawnStep(input: SpawnDecisionInput): Result<SpawnPlan> {
  if (!input.dispatchId) return unknown("dispatch identity cannot be determined");
  if (!stepBelongsToRuntime(input.runtime, input.step)) {
    return unknown(`spawn step cannot be determined for ${input.runtime} runtime: ${input.step}`);
  }

  if (input.step === "prompt-transport") {
    if (!isPromptTransportOutcome(input.outcome)) {
      return unknown("prompt transport outcome cannot be determined");
    }
    if (input.outcome.status === "failed") return planFailure(input, spawnFailureReasons[input.step]);
    return planSuccess(input, input.outcome.status);
  }

  if (isPromptTransportOutcome(input.outcome)) return unknown(`non-transport outcome cannot be determined for ${input.step}`);
  if (input.outcome.kind === "failed") return planFailure(input, spawnFailureReasons[input.step]);
  return planSuccess(input, input.outcome.kind);
}
