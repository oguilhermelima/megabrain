import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { createDispatch, getDispatch, listMessages } from "../../src/adapters/state-db.js";
import { route } from "../../src/cli/router.js";
import { guardedStateDatabase } from "./state-db-guard.js";

const roots: string[] = [];
function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

async function state(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-operator-`);
  roots.push(root);
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  const now = new Date().toISOString();
  requireOk(createDispatch(db, {
    dispatchId: "dispatch-20261015000000000-1-aaaaaaaa", state: "running", parentHost: "local",
    parentSessionId: "another-session", agent: "codex", createdAt: now, updatedAt: now,
  }));
  return root;
}

const adapter: ProcessAdapter = {
  async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
  async startDetached() { return ok({ pid: 1 }); },
  invocationCount() { return 0; },
};

async function reply(root: string, operator: boolean, extra: Record<string, string> = {}) {
  const db = requireOk(guardedStateDatabase({ MEGABRAIN_STATE_DIR: root }));
  const result = await route([
    "orchestrate", "reply", "dispatch-20261015000000000-1-aaaaaaaa", "--text", "hello", ...(operator ? ["--operator"] : []), "--json",
  ], { environment: { MEGABRAIN_STATE_DIR: root, MEGABRAIN_SESSION_ID: "current-session", MEGABRAIN_SESSION_HOST: "local", ...extra }, processAdapter: adapter });
  const messages = requireOk(listMessages(db, "dispatch-20261015000000000-1-aaaaaaaa"));
  return { result, messages, dispatch: requireOk(getDispatch(db, "dispatch-20261015000000000-1-aaaaaaaa")) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("--operator compatibility", () => {
  test("ordinary callers can act on a dispatch owned by another session", async () => {
    const root = await state();
    const outcome = await reply(root, false);
    expect(outcome.result.kind).toBe("ok");
    expect(outcome.messages.filter((message) => message.type === "reply")).toMatchObject([
      { from: "parent", text: "hello", sessionId: "current-session" },
    ]);
    expect(outcome.dispatch).toMatchObject({ parentSessionId: "another-session" });
  });

  test("--operator remains accepted as a no-op", async () => {
    const root = await state();
    const outcome = await reply(root, true);
    expect(outcome.result.kind).toBe("ok");
    expect(outcome.messages.filter((message) => message.type === "reply")).toMatchObject([
      { from: "parent", text: "hello", sessionId: "current-session" },
    ]);
  });

  test.each([
    ["agent", { CLAUDE_CODE_SESSION_ID: "agent-session" }],
    ["child", { MEGABRAIN_DISPATCH_ID: "child-dispatch" }],
  ] as const)("does not refuse --operator for %s callers", async (_caller, identity) => {
    const root = await state();
    expect((await reply(root, true, identity)).result.kind).toBe("ok");
  });
});
