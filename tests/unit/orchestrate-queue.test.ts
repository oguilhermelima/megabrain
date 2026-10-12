import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { createDispatch, appendParentReply, ackDelivery, claimDelivery, listDeliveries, listMessages, listOutbox, stateDatabase } from "../../src/adapters/state-db.js";
import { executeOrchestrateQueue } from "../../src/cli/commands/orchestrate-queue.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { executeCheck } from "../../src/cli/commands/check.js";

type RecordValue = Record<string, unknown>;
const roots: string[] = [];

function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

async function state(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-queue-`);
  roots.push(root);
  return root;
}

function environment(root: string, identity = "parent-one"): Record<string, string> {
  return { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: identity };
}

function adapter(): ProcessAdapter {
  return {
    async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
    async startDetached() { return ok({ pid: 1 }); },
    invocationCount() { return 0; },
  };
}

function dispatch(root: string, id: string, owner: string, state = "running"): void {
  const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
  requireOk(createDispatch(db, {
    dispatchId: id, state, parentHost: "orca", parentSessionId: owner,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
}

function reply(root: string, id: string, text: string, outboxId: string): string {
  const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
  const result = requireOk(appendParentReply(db, id, { from: "parent", type: "reply", text, sessionId: "parent-one" }, {
    supersede: false,
    outbox: {
      id: outboxId, targetKind: "child-delivery", target: "child-terminal",
      payload: { dispatchId: id, sequence: 1, fullMessage: text, meta: { terminalId: "child-terminal", agent: "codex" } },
    },
  })) as RecordValue;
  const deliveries = requireOk(listDeliveries(db, id));
  return String(deliveries[0]?.id ?? result.seq);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orchestrate queue", () => {
  test("lists only the caller's own outstanding replies", async () => {
    const root = await state();
    dispatch(root, "dispatch-owned", "parent-one");
    dispatch(root, "dispatch-foreign", "parent-two");
    reply(root, "dispatch-owned", "owned reply", "outbox-owned");
    reply(root, "dispatch-foreign", "foreign reply", "outbox-foreign");

    const result = await executeOrchestrateQueue(["--json"], environment(root), adapter());

    expect(result.kind).toBe("ok");
    const items = JSON.parse(result.kind === "ok" ? result.value : "[]") as RecordValue[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ dispatch: "dispatch-owned", type: "reply", text: "owned reply" });
  });

  test("hides replies from closed dispatches unless --all is requested", async () => {
    const root = await state();
    dispatch(root, "dispatch-open", "parent-one");
    dispatch(root, "dispatch-closed", "parent-one", "closed");
    reply(root, "dispatch-open", "current reply", "outbox-open");
    reply(root, "dispatch-closed", "historical reply", "outbox-closed");

    const current = await executeOrchestrateQueue(["--json"], environment(root), adapter());
    expect(current.kind).toBe("ok");
    expect(JSON.parse(current.kind === "ok" ? current.value : "[]").map((item: RecordValue) => item.dispatch)).toEqual(["dispatch-open"]);

    const all = await executeOrchestrateQueue(["--all", "--json"], environment(root), adapter());
    expect(all.kind).toBe("ok");
    expect(JSON.parse(all.kind === "ok" ? all.value : "[]").map((item: RecordValue) => item.dispatch).sort()).toEqual(["dispatch-closed", "dispatch-open"]);
  });

  test("cancelling a queued reply removes it from check and the worker does not send it", async () => {
    const root = await state();
    dispatch(root, "dispatch-owned", "parent-one");
    const deliveryId = reply(root, "dispatch-owned", "do not send", "outbox-cancelled");

    const cancelled = await executeOrchestrateQueue(["cancel", deliveryId, "--reason", "operator withdrew it"], environment(root), adapter());
    expect(cancelled.kind).toBe("ok");

    const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
    expect(requireOk(listDeliveries(db, "dispatch-owned"))[0]).toMatchObject({ status: "cancelled" });
    expect(requireOk(listOutbox(db)).find((item) => item.id === "outbox-cancelled")).toMatchObject({ status: "cancelled" });
    const history = requireOk(listMessages(db, "dispatch-owned")) as RecordValue[];
    expect(history.at(-1)).toMatchObject({ type: "cancel", text: "operator withdrew it" });

    const checkResult = await executeCheck(["--timeout", "0", "--json"], {
      ...environment(root, "child-terminal"), MEGABRAIN_DISPATCH_ID: "dispatch-owned",
    }, adapter());
    expect(checkResult.kind).toBe("ok");
    expect(JSON.parse(checkResult.kind === "ok" ? checkResult.value : "{}")).toMatchObject({ status: "empty", deliveryId: null });

    const workerCalls: string[] = [];
    const process = {
      ...adapter(),
      async run(command: string, args: readonly string[]) {
        workerCalls.push(`${command} ${args.join(" ")}`);
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
    } as ProcessAdapter;
    await executeDeliveryWorker(["outbox-cancelled", "holder", "lease", String(Date.now() + 1_000)], { MEGABRAIN_STATE_DIR: root }, process);
    expect(workerCalls).toEqual([]);
    expect(requireOk(listOutbox(db)).find((item) => item.id === "outbox-cancelled")).toMatchObject({ status: "cancelled", attempts: 0 });
  });

  test("refuses to cancel a foreign item", async () => {
    const root = await state();
    dispatch(root, "dispatch-foreign", "parent-two");
    const deliveryId = reply(root, "dispatch-foreign", "foreign reply", "outbox-foreign");

    const result = await executeOrchestrateQueue(["cancel", deliveryId], environment(root), adapter());

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("not owned by this caller");
  });

  test("refuses an acknowledged reply as already read", async () => {
    const root = await state();
    dispatch(root, "dispatch-owned", "parent-one");
    const deliveryId = reply(root, "dispatch-owned", "already read", "outbox-read");
    const db = requireOk(stateDatabase({ MEGABRAIN_STATE_DIR: root }));
    requireOk(claimDelivery(db, deliveryId, "orca/parent-one", 1));
    requireOk(ackDelivery(db, deliveryId, "orca/parent-one", 1));

    const result = await executeOrchestrateQueue(["cancel", deliveryId], environment(root), adapter());

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("already read");
  });
});
