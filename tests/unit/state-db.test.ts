import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { latestSchemaVersion } from "../../src/db/db.js";
import {
  ackDelivery,
  appendMessage,
  archiveDispatch,
  claimOutbox,
  createDelivery,
  createDispatch,
  fenceDelivery,
  finishOutbox,
  listDispatches,
  listMessages,
  listOutbox,
  mutateDispatch,
  stateDatabase,
} from "../../src/adapters/state-db.js";

const moduleUrl = new URL("../../src/adapters/state-db.ts", import.meta.url).href;
let stateDirectory = "";
let environment: { MEGABRAIN_STATE_DIR: string };

beforeEach(() => {
  stateDirectory = mkdtempSync(resolve(tmpdir(), "megabrain-state-facade-"));
  environment = { MEGABRAIN_STATE_DIR: stateDirectory };
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

function requireOk<T>(result: { kind: "ok"; value: T } | { kind: string; error?: string }): T {
  if (result.kind !== "ok") throw new Error(result.error ?? `expected ok, received ${result.kind}`);
  return result.value;
}

describe("state database facade", () => {
  test("mutateDispatch retries a version conflict and keeps all patches", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "retry", state: "running", counter: 0, other: 0 }));
    let calls = 0;
    const result = mutateDispatch(db, "retry", (current) => {
      calls += 1;
      if (calls === 1) {
        // Simulate an intervening version advance so updateDispatch returns its conflict branch.
        db.db.run("UPDATE dispatches SET version = version + 1 WHERE id = ?", ["retry"]);
      }
      return { other: Number(current.other) + 1 };
    });
    expect(result.kind).toBe("ok");
    const final = requireOk(stateDatabase(environment));
    expect(requireOk(listDispatches(final)).find((record) => record.dispatchId === "retry")).toMatchObject({ counter: 1, other: 1 });
  });

  test("four OS processes preserve 1000 concurrent dispatch counter updates", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "counter", state: "running", counter: 0 }));
    const script = `const { stateDatabase, mutateDispatch } = await import(${JSON.stringify(moduleUrl)});\nconst directory = process.argv[1];\nconst db = stateDatabase({ MEGABRAIN_STATE_DIR: directory });\nif (db.kind !== "ok") throw Error(db.error);\nfor (let i = 0; i < 250; i++) { const result = mutateDispatch(db.value, "counter", (record) => ({ counter: Number(record.counter) + 1 })); if (result.kind !== "ok") throw Error(result.error); }`;
    const children = Array.from({ length: 4 }, () => spawnSync(process.execPath, ["-e", script, stateDirectory], {
      encoding: "utf8",
      env: { ...process.env, MEGABRAIN_STATE_DIR: stateDirectory, HOME: stateDirectory },
    }));
    for (const child of children) expect(child.status, child.stderr || child.stdout).toBe(0);
    const rows = requireOk(listDispatches(requireOk(stateDatabase(environment))));
    expect(rows.find((record) => record.dispatchId === "counter")?.counter).toBe(1000);
  });

  test("four OS processes allocate contiguous, unique message sequences", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "messages", state: "running" }));
    const script = `const { stateDatabase, appendMessage } = await import(${JSON.stringify(moduleUrl)});\nconst directory = process.argv[1];\nconst worker = process.argv[2];\nconst db = stateDatabase({ MEGABRAIN_STATE_DIR: directory });\nif (db.kind !== "ok") throw Error(db.error);\nfor (let i = 0; i < 250; i++) { const result = appendMessage(db.value, "messages", { from: worker, type: "reply", text: String(i), createdAt: new Date().toISOString() }); if (result.kind !== "ok") throw Error(result.error); }`;
    const children = Array.from({ length: 4 }, (_, index) => spawnSync(process.execPath, ["-e", script, stateDirectory, `worker-${index}`], {
      encoding: "utf8",
      env: { ...process.env, MEGABRAIN_STATE_DIR: stateDirectory, HOME: stateDirectory },
    }));
    for (const child of children) expect(child.status, child.stderr || child.stdout).toBe(0);
    const messages = requireOk(listMessages(requireOk(stateDatabase(environment)), "messages"));
    expect(messages).toHaveLength(1000);
    expect(messages.map((message) => message.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1));
    expect(new Set(messages.map((message) => message.seq)).size).toBe(1000);
  });

  test("message idempotency returns the original sequence without inserting", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "idem", state: "running" }));
    const first = requireOk(appendMessage(db, "idem", { from: "parent", type: "reply", text: "first", idempotencyKey: "reply-1" }));
    const repeated = requireOk(appendMessage(db, "idem", { from: "parent", type: "reply", text: "changed", idempotencyKey: "reply-1" }));
    expect(repeated).toEqual(first);
    expect(requireOk(listMessages(db, "idem"))).toHaveLength(1);
    expect(requireOk(listMessages(db, "idem"))[0]?.text).toBe("first");
  });

  test("message and outbox row commit together and roll back together", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "atomic", state: "running" }));
    const message = requireOk(appendMessage(db, "atomic", { from: "child", type: "ask", text: "help" }, {
      outbox: { id: "outbox-1", targetKind: "parent", target: "session", payload: { pointer: "mail" } },
    }));
    expect(message.seq).toBe(1);
    expect(requireOk(listOutbox(db))).toHaveLength(1);
    const failed = appendMessage(db, "atomic", { from: "child", type: "ask", text: "rollback" }, {
      outbox: { id: "", targetKind: "parent", target: "session", payload: null },
    });
    expect(failed.kind).toBe("failed");
    expect(requireOk(listMessages(db, "atomic"))).toHaveLength(1);
    expect(requireOk(listOutbox(db))).toHaveLength(1);
  });

  test("outbox claim is exclusive and expired claims become available", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "outbox", state: "running" }));
    const appended = requireOk(appendMessage(db, "outbox", { from: "child", type: "ask", text: "notify" }, {
      outbox: { id: "outbox-claim", targetKind: "parent", target: "session", payload: {} },
    }));
    expect(appended.seq).toBe(1);
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-a", 60))?.status).toBe("sending");
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-b", 60))).toBeUndefined();
    expect(requireOk(finishOutbox(db, "outbox-claim", "failed", "retryable"))).toBeUndefined();
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-b", -1))?.status).toBe("sending");
  });

  test("delivery ack and fence preserve consumer and generation rules", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "deliveries", state: "running" }));
    requireOk(createDelivery(db, { id: "unclaimed", dispatchId: "deliveries", messageSeqs: [1], status: "outstanding" }));
    expect(ackDelivery(db, "unclaimed", "consumer-a", 1).kind).toBe("failed");
    requireOk(createDelivery(db, { id: "claimed", dispatchId: "deliveries", messageSeqs: [2], status: "outstanding", consumer: "consumer-a", consumerGeneration: 1 }));
    expect(requireOk(ackDelivery(db, "claimed", "consumer-a", 2))).toMatchObject({ duplicate: false });
    expect(requireOk(ackDelivery(db, "claimed", "consumer-a", 2))).toMatchObject({ duplicate: true });
    requireOk(createDelivery(db, { id: "fence", dispatchId: "deliveries", messageSeqs: [3], status: "outstanding", consumer: "consumer-a", consumerGeneration: 1 }));
    expect(requireOk(fenceDelivery(db, "fence", "consumer-a", 2))).toMatchObject({ status: "fenced" });
    expect(ackDelivery(db, "fence", "consumer-a", 2).kind).toBe("failed");
    expect(ackDelivery(db, "claimed", "consumer-b", 2).kind).toBe("failed");
  });

  test("archiveDispatch removes records from the default list only", () => {
    const db = requireOk(stateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "archive", state: "done" }));
    requireOk(archiveDispatch(db, "archive"));
    expect(requireOk(listDispatches(db)).some((record) => record.dispatchId === "archive")).toBe(false);
    expect(requireOk(listDispatches(db, { includeArchived: true })).some((record) => record.dispatchId === "archive")).toBe(true);
  });

  test("schema 003 migrates an existing version 2 database", () => {
    expect(latestSchemaVersion).toBe(3);
    const db = requireOk(stateDatabase(environment));
    const version = db.db.query<{ user_version: number }>("PRAGMA user_version").get();
    expect(version?.user_version).toBe(3);
    expect(db.db.query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(3);
  });
});
