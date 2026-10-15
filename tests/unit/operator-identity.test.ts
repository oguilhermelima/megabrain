import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { createDispatch, getDispatch, listMessages } from "../../src/adapters/state-db.js";
import { route } from "../../src/cli/router.js";
import { guardedStateDatabase } from "./state-db-guard.js";

// The desktop app is not an agent session, so it owns no dispatch. --operator lets a person's own
// program act on any dispatch without taking it over; an agent or a child may not use it.

const roots: string[] = [];
const foreignOwner = "claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d";

function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

async function state(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-operator-`);
  roots.push(root);
  return root;
}

function adapter(): ProcessAdapter {
  return {
    async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
    async startDetached() { return ok({ pid: 1 }); },
    invocationCount() { return 0; },
  };
}

function seed(root: string, id: string, fields: Record<string, unknown> = {}): void {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  const now = new Date().toISOString();
  requireOk(createDispatch(db, {
    dispatchId: id, state: "running", parentHost: "local", parentSessionId: foreignOwner,
    agent: "codex", chatName: "fix/thing", createdAt: now, updatedAt: now, ...fields,
  }));
}

function record(root: string, id: string): Record<string, unknown> {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  return requireOk(getDispatch(db, id)) ?? {};
}

function messages(root: string, id: string): ReadonlyArray<Record<string, unknown>> {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  return requireOk(listMessages(db, id)) as ReadonlyArray<Record<string, unknown>>;
}

// What the app's process looks like to megabrain: no agent session, no host, no child.
function app(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return { MEGABRAIN_STATE_DIR: root, HOME: root, ...extra };
}

const run = (args: string[], environment: Record<string, string>) => route(args, { environment, processAdapter: adapter() });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("--operator", () => {
  test("replies to a dispatch another session owns, without taking it over", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-aaaaaaaa");
    const result = await run(["orchestrate", "reply", "dispatch-20261015000000000-1-aaaaaaaa", "--text", "run the tests again", "--operator", "--json"], app(root));
    expect(result.kind).toBe("ok");
    expect(record(root, "dispatch-20261015000000000-1-aaaaaaaa")).toMatchObject({ parentHost: "local", parentSessionId: foreignOwner });
    const replies = messages(root, "dispatch-20261015000000000-1-aaaaaaaa").filter((message) => message.type === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ from: "parent", text: "run the tests again", sessionId: "operator" });
  });

  test("resolves a dispatch by suffix across every session", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-bbbbbbbb");
    const result = await run(["orchestrate", "reply", "bbbbbbbb", "--text", "hello", "--operator"], app(root));
    expect(result.kind).toBe("ok");
  });

  test("without the flag the same caller is refused", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-cccccccc");
    const result = await run(["orchestrate", "reply", "dispatch-20261015000000000-1-cccccccc", "--text", "hello"], app(root, { MEGABRAIN_SESSION_ID: "someone-else" }));
    expect(result.kind).toBe("failed");
    expect(messages(root, "dispatch-20261015000000000-1-cccccccc").filter((message) => message.type === "reply")).toHaveLength(0);
  });

  test("is refused from an agent session", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-dddddddd");
    const result = await run(["orchestrate", "reply", "dispatch-20261015000000000-1-dddddddd", "--text", "hello", "--operator"], app(root, { CLAUDE_CODE_SESSION_ID: "11111111-2222-3333-4444-555555555555" }));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.exitCode).toBe(2);
      expect(result.error).toContain("agent session");
    }
    expect(messages(root, "dispatch-20261015000000000-1-dddddddd").filter((message) => message.type === "reply")).toHaveLength(0);
  });

  test("is refused from a child", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-eeeeeeee");
    const result = await run(["orchestrate", "reply", "dispatch-20261015000000000-1-eeeeeeee", "--text", "hello", "--operator"], app(root, { MEGABRAIN_DISPATCH_ID: "dispatch-20261015000000000-1-ffffffff" }));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.exitCode).toBe(2);
    expect(messages(root, "dispatch-20261015000000000-1-eeeeeeee").filter((message) => message.type === "reply")).toHaveLength(0);
  });

  test("cannot be switched on through the environment instead of the flag", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-abababab");
    const result = await run(["orchestrate", "reply", "dispatch-20261015000000000-1-abababab", "--text", "hello"], app(root, { MEGABRAIN_SESSION_ID: "someone-else", MEGABRAIN_OPERATOR: "1" }));
    expect(result.kind).toBe("failed");
    expect(messages(root, "dispatch-20261015000000000-1-abababab").filter((message) => message.type === "reply")).toHaveLength(0);
  });

  test("cancels a queued spawn another session owns and records who did", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-cdcdcdcd", { state: "queued", queuedAt: new Date().toISOString() });
    const result = await run(["orchestrate", "queue", "cancel", "dispatch-20261015000000000-1-cdcdcdcd", "--reason", "not needed", "--operator", "--json"], app(root));
    expect(result.kind).toBe("ok");
    expect(record(root, "dispatch-20261015000000000-1-cdcdcdcd")).toMatchObject({ state: "closed", cancelledBy: "operator", parentSessionId: foreignOwner });
  });

  test("an owner's own cancel records no operator", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-efefefef", { state: "queued", queuedAt: new Date().toISOString(), parentSessionId: "owner-one" });
    const result = await run(["orchestrate", "queue", "cancel", "dispatch-20261015000000000-1-efefefef", "--reason", "not needed"], app(root, { MEGABRAIN_SESSION_ID: "owner-one", MEGABRAIN_SESSION_HOST: "local" }));
    expect(result.kind).toBe("ok");
    expect(record(root, "dispatch-20261015000000000-1-efefefef").cancelledBy).toBeUndefined();
  });

  test("closes a dispatch another session owns and records who did", async () => {
    const root = await state();
    seed(root, "dispatch-20261015000000000-1-a1a1a1a1", { state: "done", runtime: "tmux", terminalState: "released", processState: "exited" });
    const result = await run(["orchestrate", "close", "dispatch-20261015000000000-1-a1a1a1a1", "--operator", "--json"], app(root));
    expect(result.kind).toBe("ok");
    expect(record(root, "dispatch-20261015000000000-1-a1a1a1a1")).toMatchObject({ state: "closed", closedBy: "operator", parentSessionId: foreignOwner });
  });

  test("is rejected by verbs that do not take it", async () => {
    const root = await state();
    const result = await run(["orchestrate", "spawn", "--operator", "--repo", root, "--branch", "x"], app(root));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.exitCode).toBe(2);
      expect(result.error).toContain("--operator");
    }
  });
});
