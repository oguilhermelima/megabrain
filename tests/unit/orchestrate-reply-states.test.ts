import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeOrchestrateReply } from "../../src/cli/commands/orchestrate-reply.js";
import { appendMessage, appendParentReply, createDelivery, createDispatch, listDeliveries, listMessages, stateDatabase } from "../../src/adapters/state-db.js";

// End-to-end (CLI-verb level, in-process) coverage of the shell parity bugs found in
// tests/test-e2e-findings.sh: a "done" dispatch must refuse a reply exactly like
// failed/closed/circuit_broken, and a "stalled" dispatch (a state megabrain_dispatch_meta_normalize
// rewrote to "running" on every read in the shell) must accept a reply and resume to "running".
// These duplicate no coverage in parent-reply.test.ts, which only exercises the pure decision
// function — this file proves the CLI wiring actually normalizes state before checking it and
// actually persists (or withholds) the state write and the queued message.

function fakeProcess(): ProcessAdapter {
  return {
    async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
    async startDetached() { return ok({ pid: 1 }); },
    invocationCount() { return 0; },
  };
}

type JsonRecord = Record<string, unknown>;

function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

function baseMeta(overrides: JsonRecord = {}): JsonRecord {
  const now = new Date().toISOString();
  return {
    dispatchId: "dispatch-1",
    parentHost: "orca",
    parentSessionId: "parent-terminal",
    parentTerminalId: null,
    parentWorkspaceId: null,
    parentTmuxSession: null,
    parentTmuxPane: null,
    childHost: "orca",
    workspaceId: null,
    terminalId: "child-term-1",
    worktreePath: "/tmp/worktree",
    branch: "feat/example",
    agent: "codex",
    agentId: "codex",
    model: "gpt-5",
    effort: null,
    modelHonored: true,
    modelSubstitution: null,
    runtime: "host",
    spawnRuntime: "ide",
    tmuxSession: null,
    tmuxPane: null,
    label: "label",
    chain: null,
    promptDelivered: true,
    promptDelivery: "delivered",
    promptDeliveryReason: null,
    promptPublication: "published",
    promptTransport: "transported",
    promptReceipt: "received",
    promptState: "confirmed",
    processState: "running",
    terminalState: "owned",
    terminalReason: null,
    failureCount: 0,
    stage: null,
    reason: null,
    reconcileOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function tempStateDir(): Promise<string> {
  return mkdtemp(`${tmpdir()}/megabrain-reply-states-`);
}

async function writeDispatch(root: string, id: string, meta: JsonRecord): Promise<void> {
  const directory = `${root}/dispatches/${id}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/meta.json`, `${JSON.stringify(meta)}\n`);
}

async function readMeta(root: string, id: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(`${root}/dispatches/${id}/meta.json`, "utf8")) as JsonRecord;
}

function environment(root: string): Record<string, string> {
  return { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "parent-terminal" };
}

describe("parent reply database transaction", () => {
  test("preserves outstanding replies when superseding is disabled and appends a delivered reply", async () => {
    const root = await tempStateDir();
    try {
      const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
      requireOk(createDispatch(db, { dispatchId: "reply", state: "running" }));
      const old = requireOk(appendMessage(db, "reply", { from: "parent", type: "reply", text: "old" }));
      requireOk(createDelivery(db, { id: "old-delivery", dispatchId: "reply", messageSeqs: [old.seq], status: "outstanding" }));
      const result = requireOk(appendParentReply(db, "reply", { from: "parent", type: "reply", text: "new", sessionId: "parent" }, { supersede: false }));
      expect(result.seq).toBe(2);
      expect(requireOk(listMessages(db, "reply")).map((message) => message.seq)).toEqual([1, 2]);
      expect(requireOk(listDeliveries(db, "reply")).map((delivery) => delivery.status)).toEqual(["outstanding", "outstanding"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("supersedes outstanding reply deliveries and rolls back all writes if outbox encoding fails", async () => {
    const root = await tempStateDir();
    try {
      const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
      requireOk(createDispatch(db, { dispatchId: "reply", state: "running" }));
      const old = requireOk(appendMessage(db, "reply", { from: "parent", type: "reply", text: "old" }));
      requireOk(createDelivery(db, { id: "old-delivery", dispatchId: "reply", messageSeqs: [old.seq], status: "outstanding" }));
      const result = requireOk(appendParentReply(db, "reply", { from: "parent", type: "reply", text: "new", sessionId: "parent" }, { supersede: true }));
      expect(result.seq).toBe(2);
      expect(requireOk(listDeliveries(db, "reply")).find((delivery) => delivery.id === "old-delivery")?.status).toBe("superseded");

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const beforeMessages = requireOk(listMessages(db, "reply"));
      const beforeDeliveries = requireOk(listDeliveries(db, "reply"));
      const failed = appendParentReply(db, "reply", { from: "parent", type: "reply", text: "rolled back" }, {
        supersede: true,
        outbox: { id: "bad-outbox", targetKind: "terminal", target: "child", payload: cyclic },
      });
      expect(failed.kind).toBe("failed");
      expect(requireOk(listMessages(db, "reply"))).toEqual(beforeMessages);
      expect(requireOk(listDeliveries(db, "reply"))).toEqual(beforeDeliveries);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("orchestrate reply: shell-parity state rules", () => {
  test("refuses a reply to a done dispatch and leaves the queue empty", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta({ state: "done" }));
    const result: Result<string> = await executeOrchestrateReply(["dispatch-1", "--text", "late answer", "--json"], environment(root), fakeProcess());
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("is settled in state done");
    expect(result.kind === "failed" ? result.error : "").toContain("open a new dispatch for a reply");
    const meta = await readMeta(root, "dispatch-1");
    expect(meta.state).toBe("done");
    const messages = await readdir(`${root}/dispatches/dispatch-1/messages`).catch(() => []);
    expect(messages.length).toBe(0);
  });

  test("accepts a reply to a stalled dispatch, queues it, and resumes the dispatch to running", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta({ state: "stalled", processState: "running" }));
    const result = await executeOrchestrateReply(["dispatch-1", "--text", "reply reaches stalled child", "--json"], environment(root), fakeProcess());
    expect(result.kind).toBe("ok");
    const parsed = result.kind === "ok" ? (JSON.parse(result.value) as { status?: string }) : {};
    expect(parsed.status).toBe("queued");
    const meta = await readMeta(root, "dispatch-1");
    expect(meta.state).toBe("running");
    const messages = await readdir(`${root}/dispatches/dispatch-1/messages`).catch(() => []);
    expect(messages.length).toBe(1);
  });

  test("still refuses the other settled states (failed, closed, circuit_broken)", async () => {
    const root = await tempStateDir();
    for (const state of ["failed", "closed", "circuit_broken"]) {
      const id = `dispatch-${state}`;
      await writeDispatch(root, id, baseMeta({ dispatchId: id, state }));
      const result = await executeOrchestrateReply([id, "--text", "x", "--json"], environment(root), fakeProcess());
      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" ? result.error : "").toContain(`is settled in state ${state}`);
    }
  });
});
