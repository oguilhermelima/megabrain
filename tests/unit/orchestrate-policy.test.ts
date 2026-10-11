import { guardedStateDatabase } from "./state-db-guard.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import type { DatabaseHandle } from "../../src/db/db.js";
import { appendMessage, createDispatch, getDispatch, mutateDispatch } from "../../src/adapters/state-db.js";
import { executeOrchestratePolicy } from "../../src/cli/commands/orchestrate-policy.js";

let root = "";
let stateDb: DatabaseHandle | undefined;
afterEach(async () => { stateDb?.close(); stateDb = undefined; if (root !== "") await rm(root, { recursive: true, force: true }); root = ""; });

const process: ProcessAdapter = {
  run: async () => failed("unexpected process invocation"),
  startDetached: async () => failed("unexpected process invocation"),
  invocationCount: () => 0,
};

async function setup(initial: Record<string, unknown> = {}) {
  root = await mkdtemp(`${tmpdir()}/megabrain-policy-test-`);
  const db = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  stateDb = db.value;
  const created = createDispatch(db.value, {
    dispatchId: "dispatch-policy-test",
    state: "running",
    processState: "running",
    parentHost: "superset",
    parentSessionId: "parent-terminal",
    agent: "codex",
    contextPolicyState: { ceilingLatched: true, compactLatched: true, loopIterations: 1, actions: [{ id: "prior" }] },
    ...initial,
  });
  if (created.kind !== "ok") throw new Error(created.error);
  const prompt = appendMessage(db.value, "dispatch-policy-test", { from: "parent", type: "prompt", text: "original task", sessionId: "parent-terminal" });
  if (prompt.kind !== "ok") throw new Error(prompt.error);
  return root;
}

function ownedEnvironment(stateRoot: string) {
  return { MEGABRAIN_STATE_DIR: stateRoot, MEGABRAIN_SESSION_ID: "parent-terminal", MEGABRAIN_SESSION_HOST: "superset" };
}

function readMeta(stateRoot: string) {
  if (stateDb === undefined) throw new Error("dispatch database is missing");
  const result = getDispatch(stateDb, "dispatch-policy-test");
  if (result.kind !== "ok" || result.value === undefined) throw new Error("dispatch metadata is missing");
  return result.value;
}

describe("executeOrchestratePolicy", () => {
  test("changes active policy atomically and rearms only changed thresholds", async () => {
    const stateRoot = await setup({
      contextPolicy: { contextCeiling: 80, compactAt: 60, loop: true, maxIterations: 4 },
    });
    const result = await executeOrchestratePolicy(["dispatch-policy-test", "--context-ceiling", "90%", "--json"], ownedEnvironment(stateRoot), process);

    expect(result).toMatchObject({ kind: "ok" });
    expect(readMeta(stateRoot)).toMatchObject({
      contextPolicy: { contextCeiling: 90, compactAt: 60, loop: true, maxIterations: 4 },
      contextPolicyState: { ceilingLatched: false, compactLatched: true, loopIterations: 1, actions: [{ id: "prior" }] },
    });
  });

  test("accepts an absolute token threshold and refuses an ambiguous bare number", async () => {
    const stateRoot = await setup({ contextPolicy: { contextCeiling: 80, compactAt: 60 } });
    const tokens = await executeOrchestratePolicy(["dispatch-policy-test", "--context-ceiling", "150k", "--json"], ownedEnvironment(stateRoot), process);
    expect(tokens).toMatchObject({ kind: "ok" });
    expect(readMeta(stateRoot).contextPolicy).toEqual({ contextCeilingTokens: 150000, compactAt: 60 });

    const bare = await executeOrchestratePolicy(["dispatch-policy-test", "--compact-at", "90"], ownedEnvironment(stateRoot), process);
    expect(bare).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(readMeta(stateRoot).contextPolicy).toEqual({ contextCeilingTokens: 150000, compactAt: 60 });
  });

  test("requires ownership and refuses to change a completed dispatch", async () => {
    const stateRoot = await setup();
    const unauthorized = await executeOrchestratePolicy(["dispatch-policy-test", "--context-ceiling", "90%"], {
      MEGABRAIN_STATE_DIR: stateRoot,
      MEGABRAIN_SESSION_ID: "someone-else",
      MEGABRAIN_SESSION_HOST: "superset",
    }, process);
    expect(unauthorized).toMatchObject({ kind: "failed", error: expect.stringContaining("owned by") });

    if (stateDb === undefined) throw new Error("dispatch database is missing");
    const completed = mutateDispatch(stateDb, "dispatch-policy-test", (current) => ({ ...current, state: "done" }));
    if (completed.kind !== "ok") throw new Error(completed.error);
    const inactive = await executeOrchestratePolicy(["dispatch-policy-test", "--context-ceiling", "90%"], ownedEnvironment(stateRoot), process);
    expect(inactive).toMatchObject({ kind: "failed", error: "dispatch dispatch-policy-test is not active" });
  });

  test("loads the original prompt from the queue when enabling a loop live", async () => {
    const stateRoot = await setup({ contextPolicy: { contextCeiling: 90 } });
    const result = await executeOrchestratePolicy(["dispatch-policy-test", "--loop"], ownedEnvironment(stateRoot), process);
    expect(result).toMatchObject({ kind: "ok" });
    expect(readMeta(stateRoot).contextLoopPrompt).toBe("original task");
  });
});
