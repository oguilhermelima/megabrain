import { guardedStateDatabase, guardedOpenDatabase } from "./state-db-guard.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { latestSchemaVersion } from "../../src/db/db.js";
import type { DatabaseHandle } from "../../src/db/db.js";
import type { DatabaseAdapter } from "../../src/db/queries/types.js";
import { updateDispatch, type DispatchRow } from "../../src/db/queries/dispatches.js";
import {
  ackDelivery,
  acquireLease,
  appendMessage,
  archiveDispatch,
  claimOutbox,
  createDelivery,
  createDispatch,
  fenceDelivery,
  finishOutbox,
  listDispatches,
  listDeliveries,
  listMessages,
  listOutbox,
  listOutboxForDispatch,
  getQueuedDispatchId,
  listOutboxPage,
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
  test("provides bounded outbox pages with a stable cursor", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "page-dispatch", state: "running" }));
    for (const [id, createdAt] of [["page-a", "2026-01-01"], ["page-b", "2026-01-02"]]) {
      db.db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)", [id, "page-dispatch", "parent-pointer", "parent", "{}", createdAt, createdAt]);
    }
    let query = "";
    const tracked = new Proxy(db.db, {
      get(target, property, receiver) {
        if (property === "query") return <T>(sql: string) => { query = sql; return target.query<T>(sql); };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    const handle: DatabaseHandle = { path: db.path, db: tracked, close: () => db.close() };

    const first = requireOk(listOutboxPage(handle, { dispatchId: "page-dispatch", limit: 1 }));
    expect(first.rows.map((row) => row.id)).toEqual(["page-a"]);
    expect(first.nextCursor).toEqual({ createdAt: "2026-01-01", id: "page-a" });
    expect(query).toContain("LIMIT ?");
    expect(query).not.toContain("OFFSET");
    const second = requireOk(listOutboxPage(handle, { dispatchId: "page-dispatch", limit: 1, after: first.nextCursor }));
    expect(second.rows.map((row) => row.id)).toEqual(["page-b"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("finds a queued item's dispatch with direct bounded key lookups", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "queued-lookup", state: "running" }));
    db.db.run("INSERT INTO deliveries (id, dispatch_id, message_seqs, status, created_at, updated_at, extra) VALUES (?, ?, ?, ?, ?, ?, ?)", ["delivery-key", "queued-lookup", "[]", "outstanding", "2026-01-01", "2026-01-01", "{}"]);
    db.db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)", ["outbox-key", "queued-lookup", "parent-pointer", "parent", "{}", "2026-01-01", "2026-01-01"]);
    let query = "";
    const tracked = new Proxy(db.db, {
      get(target, property, receiver) {
        if (property === "query") return <T>(sql: string) => { query = sql; return target.query<T>(sql); };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    const handle: DatabaseHandle = { path: db.path, db: tracked, close: () => db.close() };

    expect(requireOk(getQueuedDispatchId(handle, "delivery-key"))).toBe("queued-lookup");
    expect(query).toContain("LIMIT 1");
    expect(requireOk(getQueuedDispatchId(handle, "outbox-key"))).toBe("queued-lookup");
    expect(query).toContain("LIMIT 1");
  });

  test("lists outbox rows through an indexed dispatch scoped page", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "outbox-scope-a", state: "running" }));
    requireOk(createDispatch(db, { dispatchId: "outbox-scope-b", state: "running" }));
    db.db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)", ["a", "outbox-scope-a", "parent-pointer", "parent", "{}", "2026-01-01", "2026-01-01"]);
    db.db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)", ["b", "outbox-scope-b", "parent-pointer", "parent", "{}", "2026-01-01", "2026-01-01"]);
    let query = "";
    const tracked = new Proxy(db.db, {
      get(target, property, receiver) {
        if (property === "query") return <T>(sql: string) => { query = sql; return target.query<T>(sql); };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    const handle: DatabaseHandle = { path: db.path, db: tracked, close: () => db.close() };

    const rows = requireOk(listOutboxForDispatch(handle, "outbox-scope-a"));

    expect(rows.map((row) => row.id)).toEqual(["a"]);
    expect(query).toContain("dispatch_id = ?");
    expect(query).toContain("LIMIT");
  });

  test("append without derivation does not load the dispatch history", () => {
    const database = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(database, { dispatchId: "append-bounded", state: "running" }));
    let historyReads = 0;
    const tracked = new Proxy(database.db, {
      get(target, property, receiver) {
        if (property === "query") return <T>(sql: string) => {
          if (sql === "SELECT * FROM messages WHERE dispatch_id = ? ORDER BY seq") historyReads += 1;
          return target.query<T>(sql);
        };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseAdapter;
    const handle: DatabaseHandle = { path: database.path, db: tracked, close: () => database.close() };

    const appended = appendMessage(handle, "append-bounded", { from: "child", type: "ask", text: "question" });

    expect(requireOk(appended)).toMatchObject({ seq: 1, text: "question" });
    expect(historyReads).toBe(0);
  });

  test("mutateDispatch retries a version conflict and keeps all patches", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "retry", state: "running", counter: 0, other: 0 }));
    let calls = 0;
    const result = mutateDispatch(db, "retry", (current) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a competing patch so the facade retries with the new record and version.
        const row = db.db.query<DispatchRow>("SELECT * FROM dispatches WHERE id = ?").get("retry");
        if (row === null) throw new Error("dispatch disappeared");
        const competing = updateDispatch(db.db, "retry", row.version, { counter: Number(current.counter) + 1 });
        if (competing.kind !== "updated") throw new Error(`competing update failed: ${competing.kind}`);
      }
      return { counter: Number(current.counter) + 1, other: Number(current.other) + 1 };
    });
    expect(result.kind).toBe("ok");
    const final = requireOk(guardedStateDatabase(environment));
    expect(requireOk(listDispatches(final)).find((record) => record.dispatchId === "retry")).toMatchObject({ counter: 2, other: 1 });
  });

  test("four OS processes preserve 1000 concurrent dispatch counter updates", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "counter", state: "running", counter: 0 }));
    const script = `const { stateDatabase, mutateDispatch } = await import(${JSON.stringify(moduleUrl)});\nconst directory = process.argv[1];\nconst db = stateDatabase({ MEGABRAIN_STATE_DIR: directory });\nif (db.kind !== "ok") throw Error(db.error);\nfor (let i = 0; i < 250; i++) { const result = mutateDispatch(db.value, "counter", (record) => ({ counter: Number(record.counter) + 1 })); if (result.kind !== "ok") throw Error(result.error); }`;
    const children = Array.from({ length: 4 }, () => spawnSync(process.execPath, ["-e", script, stateDirectory], {
      encoding: "utf8",
      env: { ...process.env, MEGABRAIN_STATE_DIR: stateDirectory, HOME: stateDirectory },
    }));
    for (const child of children) expect(child.status, child.stderr || child.stdout).toBe(0);
    const rows = requireOk(listDispatches(requireOk(guardedStateDatabase(environment))));
    expect(rows.find((record) => record.dispatchId === "counter")?.counter).toBe(1000);
  });

  test("four OS processes allocate contiguous, unique message sequences", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "messages", state: "running" }));
    const script = `const { stateDatabase, appendMessage } = await import(${JSON.stringify(moduleUrl)});\nconst directory = process.argv[1];\nconst worker = process.argv[2];\nconst db = stateDatabase({ MEGABRAIN_STATE_DIR: directory });\nif (db.kind !== "ok") throw Error(db.error);\nfor (let i = 0; i < 250; i++) { const result = appendMessage(db.value, "messages", { from: worker, type: "reply", text: String(i), createdAt: new Date().toISOString() }); if (result.kind !== "ok") throw Error(result.error); }`;
    const children = Array.from({ length: 4 }, (_, index) => spawnSync(process.execPath, ["-e", script, stateDirectory, `worker-${index}`], {
      encoding: "utf8",
      env: { ...process.env, MEGABRAIN_STATE_DIR: stateDirectory, HOME: stateDirectory },
    }));
    for (const child of children) expect(child.status, child.stderr || child.stdout).toBe(0);
    const messages = requireOk(listMessages(requireOk(guardedStateDatabase(environment)), "messages"));
    expect(messages).toHaveLength(1000);
    expect(messages.map((message) => message.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index + 1));
    expect(new Set(messages.map((message) => message.seq)).size).toBe(1000);
  });

  test("message idempotency returns the original sequence without inserting", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "idem", state: "running" }));
    const first = requireOk(appendMessage(db, "idem", { from: "parent", type: "reply", text: "first", idempotencyKey: "reply-1" }));
    const repeated = requireOk(appendMessage(db, "idem", { from: "parent", type: "reply", text: "changed", idempotencyKey: "reply-1" }));
    expect(repeated).toEqual(first);
    expect(requireOk(listMessages(db, "idem"))).toHaveLength(1);
    expect(requireOk(listMessages(db, "idem"))[0]?.text).toBe("first");
  });

  test("message and outbox row commit together and roll back together", () => {
    const db = requireOk(guardedStateDatabase(environment));
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

  test("schema stores the parent Codex thread independently from terminal identity", () => {
    const db = requireOk(guardedStateDatabase(environment));
    const columns = db.db.query<{ name: string }>("PRAGMA table_info(dispatches)").all().map(({ name }) => name);
    expect(columns).toContain("parent_agent_thread_id");
  });

  test("outbox claim is exclusive, expired claims return, and finish reports success", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "outbox", state: "running" }));
    const appended = requireOk(appendMessage(db, "outbox", { from: "child", type: "ask", text: "notify" }, {
      outbox: { id: "outbox-claim", targetKind: "parent", target: "session", payload: {} },
    }));
    expect(appended.seq).toBe(1);
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-a", 60))?.status).toBe("sending");
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-b", 60))).toBeUndefined();
    db.db.run("UPDATE outbox SET lease_until = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "outbox-claim"]);
    expect(requireOk(claimOutbox(db, "outbox-claim", "holder-b", 60))?.status).toBe("sending");
    expect(finishOutbox(db, "outbox-claim", "failed", "retryable", "holder-b").kind).toBe("ok");
    expect(finishOutbox(db, "missing", "sent").kind).toBe("failed");
  });

  test("an expired delivery target lease can be acquired by a new worker", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "dead-lease", state: "running" }));
    expect(requireOk(acquireLease(db, "delivery-target:parent", "dead-holder", 60))).toBe(true);
    db.db.run("UPDATE leases SET expires_at = ? WHERE key = ?", ["2000-01-01T00:00:00.000Z", "delivery-target:parent"]);
    expect(requireOk(acquireLease(db, "delivery-target:parent", "new-holder", 60))).toBe(true);
  });

  test("a lease held by an exited process is reclaimed before its expiry", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "dead-holder-lease", state: "running" }));
    expect(requireOk(acquireLease(db, "delivery-target:dead", "2147483000-worker", 60))).toBe(true);
    expect(requireOk(acquireLease(db, "delivery-target:dead", `${process.pid}-replacement`, 60))).toBe(true);
  });

  test("a lease held by a live process remains exclusive before its expiry", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "live-holder-lease", state: "running" }));
    expect(requireOk(acquireLease(db, "delivery-target:live", `${process.pid}-worker`, 60))).toBe(true);
    expect(requireOk(acquireLease(db, "delivery-target:live", `${process.pid + 1}-other`, 60))).toBe(false);
  });

  test("delivery ack and fence preserve consumer and generation rules", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "deliveries", state: "running" }));
    requireOk(createDelivery(db, { id: "unclaimed", dispatchId: "deliveries", messageSeqs: [1], status: "outstanding" }));
    const delivery = requireOk(listDeliveries(db, "deliveries"))[0];
    expect(delivery?.createdAt).toBeString();
    expect(delivery?.updatedAt).toBeString();
    expect(ackDelivery(db, "unclaimed", "consumer-a", 1).kind).toBe("failed");
    requireOk(createDelivery(db, { id: "claimed", dispatchId: "deliveries", messageSeqs: [2], status: "outstanding", consumer: "consumer-a", consumerGeneration: 1 }));
    expect(ackDelivery(db, "claimed", "consumer-a", 2).kind).toBe("failed");
    expect(ackDelivery(db, "claimed", "consumer-b", 1).kind).toBe("failed");
    expect(requireOk(ackDelivery(db, "claimed", "consumer-a", 1))).toMatchObject({ duplicate: false });
    expect(requireOk(ackDelivery(db, "claimed", "consumer-a", 1))).toMatchObject({ duplicate: true });
    requireOk(createDelivery(db, { id: "fence", dispatchId: "deliveries", messageSeqs: [3], status: "outstanding", consumer: "consumer-a", consumerGeneration: 1 }));
    expect(requireOk(fenceDelivery(db, "fence", "consumer-a", 2))).toMatchObject({ status: "fenced" });
    expect(ackDelivery(db, "fence", "consumer-a", 2).kind).toBe("failed");
  });

  test("archiveDispatch removes records from the default list only", () => {
    const db = requireOk(guardedStateDatabase(environment));
    requireOk(createDispatch(db, { dispatchId: "archive", state: "done" }));
    requireOk(archiveDispatch(db, "archive"));
    expect(requireOk(listDispatches(db)).some((record) => record.dispatchId === "archive")).toBe(false);
    expect(requireOk(listDispatches(db, { includeArchived: true })).some((record) => record.dispatchId === "archive")).toBe(true);
  });

  test("schema 003 migrates an existing version 2 database", () => {
    const db = requireOk(guardedStateDatabase(environment));
    db.db.run("DROP TABLE nudge_events");
    db.db.run("DROP TABLE waiters");
    db.db.exec("ALTER TABLE outbox DROP COLUMN detail");
    db.db.exec("ALTER TABLE outbox DROP COLUMN lease_holder");
    db.db.exec("ALTER TABLE dispatches DROP COLUMN agent_pid");
    db.db.exec("ALTER TABLE dispatches DROP COLUMN parent_agent_thread_id");
    db.db.exec("ALTER TABLE dispatches DROP COLUMN chat_name");
    db.db.run("DELETE FROM schema_migrations WHERE version > 2");
    db.db.run("DROP TABLE hidden_items");
    db.db.run("DROP TABLE resource_samples");
    db.db.exec("DROP INDEX IF EXISTS worktrees_repo_parent_branch; ALTER TABLE worktrees DROP COLUMN parent_branch;");
    db.db.exec("DROP TABLE settings");
    db.db.exec("PRAGMA user_version = 2");
    db.close();
    const migrated = requireOk(guardedOpenDatabase(environment));
    const version = migrated.db.query<{ user_version: number }>("PRAGMA user_version").get();
    expect(version?.user_version).toBe(latestSchemaVersion);
    expect(migrated.db.query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(latestSchemaVersion);
    expect(migrated.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'waiters'").get()?.name).toBe("waiters");
  });
});
