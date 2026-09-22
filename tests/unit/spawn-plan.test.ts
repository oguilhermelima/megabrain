import { describe, expect, test } from "bun:test";
import { checkDispatchTransition } from "../../src/core/dispatch-states.js";
import {
  decideSpawnStep,
  type SpawnDecisionInput,
  type SpawnPlan,
  type SpawnState,
  type SpawnStep,
} from "../../src/core/spawn-plan.js";

const initialState: SpawnState = {
  dispatch: "spawning",
  process: "starting",
  terminal: "owned",
};

function input(overrides: Partial<SpawnDecisionInput> = {}): SpawnDecisionInput {
  return {
    dispatchId: "dispatch-1",
    runtime: "host",
    worktree: "created",
    state: initialState,
    step: "prompt-publication",
    outcome: { kind: "succeeded" },
    ...overrides,
  };
}

function planFor(result: ReturnType<typeof decideSpawnStep>): SpawnPlan {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected a spawn plan");
  return result.value;
}

function expectLegalTransition(before: SpawnState, after: SpawnState): void {
  expect(checkDispatchTransition("dispatch", before.dispatch, after.dispatch).kind).toBe("ok");
  expect(checkDispatchTransition("process", before.process, after.process).kind).toBe("ok");
  expect(checkDispatchTransition("terminal", before.terminal, after.terminal).kind).toBe("ok");
}

describe("spawn prompt transport outcomes", () => {
  test("delivered continues to prompt confirmation", () => {
    const plan = planFor(decideSpawnStep(input({
      runtime: "tmux",
      step: "prompt-transport",
      outcome: { kind: "prompt-transport", status: "delivered" },
    })));

    expect(plan.nextStep).toBe("prompt-confirmation");
    expect(plan.reason).toBeNull();
    expect(plan.cleanup.kind).toBe("none");
    expect(plan.exitCode).toBe(0);
    expect(plan.reconcile).toBeNull();
    expectLegalTransition(initialState, plan.state);
  });

  test("awaiting receipt succeeds, leaves the dispatch open, and points to reconcile", () => {
    const plan = planFor(decideSpawnStep(input({
      runtime: "tmux",
      step: "prompt-transport",
      outcome: { kind: "prompt-transport", status: "awaiting-receipt" },
    })));

    expect(plan.nextStep).toBe("prompt-state-persist");
    expect(plan.reason).toBeNull();
    expect(plan.cleanup.kind).toBe("none");
    expect(plan.exitCode).toBe(0);
    expect(plan.lifecycle).toBe("open");
    expect(plan.reconcile).toEqual({ instruction: "megabrain orchestrate reconcile dispatch-1" });
    expectLegalTransition(initialState, plan.state);
  });

  test("transport failure is a failure and cleans up the tmux launch", () => {
    const plan = planFor(decideSpawnStep(input({
      runtime: "tmux",
      step: "prompt-transport",
      outcome: { kind: "prompt-transport", status: "failed" },
    })));

    expect(plan.nextStep).toBeNull();
    expect(plan.reason).toBe("prompt-transport-failed");
    expect(plan.cleanup).toEqual({ kind: "required", runtime: "tmux", worktree: "remove" });
    expect(plan.exitCode).toBe(1);
    expect(plan.lifecycle).toBe("open");
    expect(plan.state).toEqual({ dispatch: "failed", process: "failed", terminal: "released" });
    expectLegalTransition(initialState, plan.state);
  });
});

describe("spawn failure reasons", () => {
  const failures: ReadonlyArray<{
    readonly step: SpawnStep;
    readonly runtime: "tmux" | "host";
    readonly reason: string;
    readonly outcome?: SpawnDecisionInput["outcome"];
  }> = [
    { step: "prompt-publication", runtime: "host", reason: "prompt-publication-failed" },
    { step: "command-submission", runtime: "host", reason: "command-not-submitted" },
    { step: "readiness-wait", runtime: "host", reason: "readiness-timeout" },
    { step: "readiness-output-validation", runtime: "tmux", reason: "readiness-output-invalid" },
    {
      step: "prompt-transport",
      runtime: "host",
      reason: "prompt-transport-failed",
      outcome: { kind: "prompt-transport", status: "failed" },
    },
    { step: "prompt-confirmation", runtime: "host", reason: "prompt-confirmation-failed" },
    { step: "transcript-start", runtime: "tmux", reason: "transcript-start-failed" },
    { step: "state-persist", runtime: "host", reason: "state-persist-failed" },
    { step: "metadata-read-before-command", runtime: "host", reason: "metadata-read-failed" },
    { step: "model-substitution-record", runtime: "tmux", reason: "model-substitution-record-failed" },
    { step: "prompt-state-persist", runtime: "host", reason: "prompt-state-persist-failed" },
  ];

  test.each(failures)("$step raises $reason", ({ step, runtime, reason, outcome }) => {
    const plan = planFor(decideSpawnStep(input({
      runtime,
      step,
      outcome: outcome ?? { kind: "failed" },
    })));

    expect(plan.reason).toBe(reason);
    expect(plan.exitCode).toBe(1);
    expect(plan.nextStep).toBeNull();
    expect(plan.cleanup).toEqual({ kind: "required", runtime, worktree: "remove" });
    expect(plan.state).toEqual({ dispatch: "failed", process: "failed", terminal: "released" });
    expectLegalTransition(initialState, plan.state);
  });

  test("metadata-read-failed is raised by both metadata read steps", () => {
    const beforeCommand = planFor(decideSpawnStep(input({ step: "metadata-read-before-command", outcome: { kind: "failed" } })));
    const afterReadiness = planFor(decideSpawnStep(input({ step: "metadata-read-after-readiness", outcome: { kind: "failed" } })));

    expect(beforeCommand.reason).toBe("metadata-read-failed");
    expect(afterReadiness.reason).toBe("metadata-read-failed");
    expect(beforeCommand.cleanup).toEqual(afterReadiness.cleanup);
  });
});

describe("spawn cleanup ownership", () => {
  test("removes a worktree created by this invocation", () => {
    const plan = planFor(decideSpawnStep(input({ worktree: "created", outcome: { kind: "failed" } })));

    expect(plan.cleanup).toEqual({ kind: "required", runtime: "host", worktree: "remove" });
  });

  test("preserves a pre-existing worktree on launch failure", () => {
    const plan = planFor(decideSpawnStep(input({ worktree: "existing", outcome: { kind: "failed" } })));

    expect(plan.cleanup).toEqual({ kind: "required", runtime: "host", worktree: "preserve" });
  });

  test("does not guess when worktree ownership is unknown", () => {
    const result = decideSpawnStep(input({ worktree: "unknown", outcome: { kind: "failed" } }));

    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.reason).toContain("worktree ownership");
  });

  test("distinguishes tmux and host cleanup", () => {
    const tmux = planFor(decideSpawnStep(input({ runtime: "tmux", outcome: { kind: "failed" } })));
    const host = planFor(decideSpawnStep(input({ runtime: "host", outcome: { kind: "failed" } })));

    expect(tmux.cleanup).toEqual({ kind: "required", runtime: "tmux", worktree: "remove" });
    expect(host.cleanup).toEqual({ kind: "required", runtime: "host", worktree: "remove" });
  });
});

describe("spawn step sequencing", () => {
  test("uses the tmux and host sequences without performing them", () => {
    const tmux = planFor(decideSpawnStep(input({ runtime: "tmux", step: "transcript-start" })));
    const host = planFor(decideSpawnStep(input({ runtime: "host", step: "prompt-publication" })));

    expect(tmux.nextStep).toBe("prompt-publication");
    expect(host.nextStep).toBe("metadata-read-before-command");
    expect(tmux.cleanup.kind).toBe("none");
    expect(host.cleanup.kind).toBe("none");
  });

  test("places host command submission before readiness and prompt transport", () => {
    const command = planFor(decideSpawnStep(input({ runtime: "host", step: "command-submission" })));
    const readiness = planFor(decideSpawnStep(input({ runtime: "host", step: "readiness-wait" })));
    const metadata = planFor(decideSpawnStep(input({ runtime: "host", step: "metadata-read-before-command" })));

    expect(command.nextStep).toBe("readiness-wait");
    expect(readiness.nextStep).toBe("metadata-read-after-readiness");
    expect(metadata.nextStep).toBe("command-submission");
  });

  test("marks a confirmed prompt as running", () => {
    const afterConfirmation = planFor(decideSpawnStep(input({
      step: "prompt-confirmation",
      outcome: { kind: "succeeded" },
    })));
    const running = planFor(decideSpawnStep(input({
      step: "state-persist",
      outcome: { kind: "succeeded" },
    })));

    expect(afterConfirmation.nextStep).toBe("state-persist");
    expect(running.nextStep).toBeNull();
    expect(running.state).toEqual({ dispatch: "running", process: "running", terminal: "owned" });
    expectLegalTransition(initialState, running.state);
  });
});
