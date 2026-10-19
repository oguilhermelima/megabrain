import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { callStateOwner, inspectStateOwner, startStateOwner, stateOwnerSocket, stopStateOwner, type StateOwnerRequest } from "../../src/db/state-owner.js";
import { inspectDatabase, openDatabase, openDatabaseReadOnly } from "../../src/db/db.js";
import { createDispatch } from "../../src/adapters/state/dispatches.js";
import { getTmuxSession, putTmuxSession } from "../../src/adapters/state/machine.js";
import { insertOutbox } from "../../src/db/queries/outbox-leases.js";
import { insertDelivery } from "../../src/db/queries/deliveries.js";
import { insertMessage } from "../../src/db/queries/messages.js";
import { withWrite } from "../../src/db/db.js";
import { readCutoverMarker } from "../../src/db/cutover.js";
import { cleanupTrackedStateOwners, trackStateOwnerCleanup } from "../helpers/state-owner-cleanup.js";

let root: string;
let owner: Awaited<ReturnType<typeof startStateOwner>> | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mb-state-owner-")); });
afterEach(async () => {
  if (owner !== undefined) await stopStateOwner(owner);
  owner = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("single state owner", () => {
  test("status reports a stopped owner without starting it", async () => {
    const stopped = await inspectStateOwner(root);
    expect(stopped).toMatchObject({ running: false });
    owner = await startStateOwner(root);
    expect(await inspectStateOwner(root)).toMatchObject({ running: true, pid: process.pid });
  });
  test("a read of a missing database starts the owner before opening read-only", async () => {
    const opened = openDatabaseReadOnly({ MEGABRAIN_STATE_DIR: root });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(opened.value.db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(16);
      expect(await inspectStateOwner(root)).toMatchObject({ running: true });
    } finally {
      opened.value.close();
      const status = await inspectStateOwner(root);
      if (status.running) {
        try { process.kill(status.pid, "SIGTERM"); } catch { /* owner exited already */ }
        const deadline = Date.now() + 2_000;
        let current = await inspectStateOwner(root);
        while (current.running && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          current = await inspectStateOwner(root);
        }
      }
    }
  });
  test("owner creates its unversioned request ledger for an older schema", async () => {
    const before = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (before.kind !== "ok") throw new Error(before.error);
    expect(before.value.db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(16);
    expect(before.value.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_owner_requests'").get()).toBeNull();
    before.value.close();

    owner = await startStateOwner(root);
    expect(owner.handle.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_owner_requests'").get()?.name).toBe("state_owner_requests");
    expect(owner.handle.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'state_owner_requests_applied_at'").get()?.name).toBe("state_owner_requests_applied_at");
    expect(owner.handle.db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(16);
    expect(owner.handle.db.query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations").get()?.version).toBe(16);
  });


  test("a client write is committed by the owner", async () => {
    owner = await startStateOwner(root);
    const written = await callStateOwner(root, { operation: "setting-write", key: "owner-test", value: "committed" });
    expect(written).toEqual({ written: true });

    const integrity = inspectDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(integrity.kind).toBe("ok");
    const log = readFileSync(join(root, "logs", "state-owner.log"), "utf8");
    expect(log).toContain('"event":"starting"');
    expect(log).toContain('"event":"ready"');
    expect(log).toContain('"event":"request-start"');
    expect(log).toContain('"event":"request-committed"');
  });

  test("renewing an outbox lease extends only the current holder claim", async () => {
    owner = await startStateOwner(root);
    expect(createDispatch(owner.handle, { dispatchId: "renew-outbox", state: "running" }).kind).toBe("ok");
    const now = new Date().toISOString();
    withWrite(owner.handle, (db) => insertOutbox(db, {
      id: "renew-outbox-row", dispatchId: "renew-outbox", targetKind: "parent-pointer", target: "parent",
      payload: {}, status: "pending", attempts: 0, leaseUntil: null, transport: null,
      createdAt: now, updatedAt: now, leaseHolder: null, detail: null,
    }));
    await callStateOwner(root, { operation: "claim-outbox", id: "renew-outbox-row", holder: "holder-a", leaseSeconds: 1 });
    const renewed = await callStateOwner(root, { operation: "renew-outbox", id: "renew-outbox-row", holder: "holder-a", leaseSeconds: 90 } as StateOwnerRequest);
    expect(renewed).toBe(true);
    const lease = owner.handle.db.query<{ lease_until: string | null }>("SELECT lease_until FROM outbox WHERE id = ?").get("renew-outbox-row")?.lease_until;
    expect(lease === null || lease === undefined ? 0 : Date.parse(lease) - Date.now()).toBeGreaterThan(80_000);
    expect(await callStateOwner(root, { operation: "renew-outbox", id: "renew-outbox-row", holder: "holder-b", leaseSeconds: 90 } as StateOwnerRequest)).toBe(false);
  });

  test("a stale outbox holder cannot finish a row reclaimed by another worker", async () => {
    owner = await startStateOwner(root);
    expect(createDispatch(owner.handle, { dispatchId: "fenced-outbox", state: "running" }).kind).toBe("ok");
    const now = new Date().toISOString();
    withWrite(owner.handle, (db) => insertOutbox(db, {
      id: "fenced-outbox-row", dispatchId: "fenced-outbox", targetKind: "parent-pointer", target: "parent",
      payload: {}, status: "pending", attempts: 0, leaseUntil: null, transport: null,
      createdAt: now, updatedAt: now, leaseHolder: null, detail: null,
    }));
    await callStateOwner(root, { operation: "claim-outbox", id: "fenced-outbox-row", holder: "holder-a", leaseSeconds: 90 });
    owner.handle.db.run("UPDATE outbox SET lease_until = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", "fenced-outbox-row"]);
    await callStateOwner(root, { operation: "claim-outbox", id: "fenced-outbox-row", holder: "holder-b", leaseSeconds: 90 });
    expect(await callStateOwner(root, { operation: "finish-outbox", id: "fenced-outbox-row", holder: "holder-a", status: "failed", detail: "stale" } as StateOwnerRequest)).toBe(false);
    expect(owner.handle.db.query<{ status: string; lease_holder: string | null }>("SELECT status, lease_holder FROM outbox WHERE id = ?").get("fenced-outbox-row")).toEqual({ status: "sending", lease_holder: "holder-b" });
  });

  test("acknowledging a delivered message completes its matching outbox row", async () => {
    owner = await startStateOwner(root);
    expect(createDispatch(owner.handle, { dispatchId: "owner-ack-outbox", state: "running" }).kind).toBe("ok");
    const now = new Date().toISOString();
    const seeded = withWrite(owner.handle, (db) => {
      insertMessage(db, "owner-ack-outbox", { seq: 1, from: "parent", type: "reply", text: "continue", sessionId: "parent", createdAt: now });
      insertDelivery(db, { id: "delivery-owner-ack", dispatchId: "owner-ack-outbox", recipient: "child", messageSeqs: [1], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      insertOutbox(db, { id: "outbox-owner-ack", dispatchId: "owner-ack-outbox", targetKind: "child-delivery", target: "child-terminal", payload: { sequence: 1 }, status: "pending", attempts: 0, leaseUntil: null, transport: null, createdAt: now, updatedAt: now, leaseHolder: null, detail: null });
    });
    expect(seeded.kind).toBe("ok");

    expect(await callStateOwner(root, { operation: "ack-implicit-delivery", dispatchId: "owner-ack-outbox", deliveryId: "delivery-owner-ack", recipient: "child" })).toBe(true);
    expect(owner.handle.db.query<{ status: string; detail: string | null }>("SELECT status, detail FROM outbox WHERE id = ?").get("outbox-owner-ack")).toEqual({ status: "sent", detail: "receiver acknowledged" });
  });

  test("explicit child acknowledgement completes its matching outbox row", async () => {
    owner = await startStateOwner(root);
    expect(createDispatch(owner.handle, { dispatchId: "owner-explicit-ack", state: "running" }).kind).toBe("ok");
    const now = new Date().toISOString();
    const seeded = withWrite(owner.handle, (db) => {
      insertMessage(db, "owner-explicit-ack", { seq: 1, from: "parent", type: "reply", text: "continue", sessionId: "parent", createdAt: now });
      insertDelivery(db, { id: "delivery-owner-explicit-ack", dispatchId: "owner-explicit-ack", recipient: "child", messageSeqs: [1], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      insertOutbox(db, { id: "outbox-owner-explicit-ack", dispatchId: "owner-explicit-ack", targetKind: "child-delivery", target: "child-terminal", payload: { sequence: 1 }, status: "pending", attempts: 0, leaseUntil: null, transport: null, createdAt: now, updatedAt: now, leaseHolder: null, detail: null });
    });
    expect(seeded.kind).toBe("ok");
    expect(await callStateOwner(root, { operation: "claim-delivery", id: "delivery-owner-explicit-ack", consumer: "child", generation: 1 })).toMatchObject({ status: "outstanding" });

    expect(await callStateOwner(root, { operation: "ack-delivery", id: "delivery-owner-explicit-ack", consumer: "child", generation: 1 })).toEqual({ duplicate: false });
    expect(owner.handle.db.query<{ status: string; detail: string | null }>("SELECT status, detail FROM outbox WHERE id = ?").get("outbox-owner-explicit-ack")).toEqual({ status: "sent", detail: "receiver acknowledged" });
  });

  test("dispatch pruning archive and deletion run through the owner", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "owner-archive", state: "done" }).kind).toBe("ok");
    expect(createDispatch(seeded.value, { dispatchId: "owner-delete", state: "done" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);

    expect(await callStateOwner(root, { operation: "dispatch-prune", action: "archive", dispatchId: "owner-archive", archivedAt: "2026-10-18T00:00:00.000Z" })).toEqual({ changed: true });
    expect(await callStateOwner(root, { operation: "dispatch-prune", action: "delete", dispatchId: "owner-delete" })).toEqual({ changed: true });
    expect(owner.handle.db.query<{ archived_at: string | null }>("SELECT archived_at FROM dispatches WHERE id = ?").get("owner-archive")?.archived_at).toBe("2026-10-18T00:00:00.000Z");
    expect(owner.handle.db.query("SELECT id FROM dispatches WHERE id = ?").get("owner-delete")).toBeNull();
  });

  test("automatic legacy cutover is performed through the owner", async () => {
    owner = await startStateOwner(root);
    expect(readCutoverMarker(owner.handle).value).toBeUndefined();
    const result = await callStateOwner(root, { operation: "automatic-cutover" }) as { migrated: boolean; method: string };
    expect(result).toMatchObject({ migrated: true, method: "auto" });
    expect(readCutoverMarker(owner.handle).value).toMatchObject({ method: "auto" });
  });

  test("explicit legacy migration is performed through the owner", async () => {
    owner = await startStateOwner(root);
    const result = await callStateOwner(root, { operation: "manual-migrate" }) as { migrated: boolean; method: string };
    expect(result).toMatchObject({ migrated: true, method: "migrate" });
    expect(readCutoverMarker(owner.handle).value).toMatchObject({ method: "migrate" });
  });

  test("peer verification work is scheduled by the owner process", async () => {
    owner = await startStateOwner(root);
    expect(await callStateOwner(root, { operation: "resume-verification", id: "missing-verification" })).toEqual({ scheduled: true });
    const deadline = Date.now() + 1_000;
    while (owner.scheduledVerifications.has("missing-verification") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(owner.scheduledVerifications.has("missing-verification")).toBe(false);
    expect(owner.pendingDeliveries.size).toBe(0);
  });

  test("an on-demand test owner exits once its temporary state is idle", async () => {
    expect(await callStateOwner(root, { operation: "setting-write", key: "idle-test", value: "written" })).toEqual({ written: true });
    const deadline = Date.now() + 5_000;
    let status = await inspectStateOwner(root);
    while (status.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await inspectStateOwner(root);
    }
    expect(status).toEqual({ running: false });
  });

  test("a test owner exits when its parent runner has gone away", async () => {
    owner = await startStateOwner(root, undefined, {
      MEGABRAIN_STATE_DIR: root,
      MEGABRAIN_STATE_OWNER_TEST_MODE: "1",
      MEGABRAIN_STATE_OWNER_TEST_PARENT_PID: "2147483647",
      MEGABRAIN_STATE_OWNER_IDLE_MS: "30000",
    });
    const deadline = Date.now() + 2_000;
    let status = await inspectStateOwner(root);
    while (status.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = await inspectStateOwner(root);
    }
    expect(status).toEqual({ running: false });
    owner = undefined;
  });

  test("a detached owner exits within one second after SIGTERM", async () => {
    const binary = join(process.cwd(), ".build", "megabrain");
    const environment = { ...process.env, HOME: root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_STATE_OWNER_DIR: root, MEGABRAIN_STATE_OWNER_IDLE_MS: "30000", MEGABRAIN_STATE_OWNER_TEST_MODE: "0" };
    delete environment.MEGABRAIN_DISPATCH_ID;
    const child = spawn(binary, ["__state-owner"], { detached: true, stdio: "ignore", env: environment });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    let heldConnection: ReturnType<typeof createConnection> | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await inspectStateOwner(root)).running) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await inspectStateOwner(root)).toMatchObject({ running: true });
      heldConnection = createConnection(stateOwnerSocket(root));
      await new Promise<void>((resolve, reject) => {
        heldConnection.once("connect", resolve);
        heldConnection.once("error", reject);
      });
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const result = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000))]);
      expect(result).not.toBe("timeout");
      if (result !== "timeout") expect(Date.now() - signalledAt).toBeLessThan(1_000);
    } finally {
      heldConnection?.destroy();
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the test owner registry records each owned temporary directory", async () => {
    owner = await startStateOwner(root);
    const registry = process.env.MEGABRAIN_STATE_OWNER_TEST_REGISTRY;
    expect(registry).toBeDefined();
    const entries = readFileSync(registry as string, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; stateDir: string });
    expect(entries).toContainEqual({ pid: process.pid, stateDir: root });
  });

  test("a second owner cannot bind the same state directory", async () => {
    owner = await startStateOwner(root);
    await expect(startStateOwner(root)).rejects.toThrow(/already running/);
  });

  test("concurrent starts produce exactly one owner before the socket is published", async () => {
    const outcomes = await Promise.allSettled([startStateOwner(root), startStateOwner(root)]);
    const started = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof startStateOwner>>> => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    owner = started[0]?.value;
    expect(owner).toBeDefined();
    expect(await inspectStateOwner(root)).toMatchObject({ running: true, pid: process.pid });
  });

  test("a detached owner exits when its state directory is removed", async () => {
    expect(await callStateOwner(root, { operation: "setting-write", key: "removed-state", value: "written" })).toEqual({ written: true });
    const status = await inspectStateOwner(root);
    if (!status.running) throw new Error("detached state owner did not start");
    trackStateOwnerCleanup(root);
    try {
      rmSync(root, { recursive: true, force: true });
      const deadline = Date.now() + 2_500;
      let exited = false;
      while (!exited && Date.now() < deadline) {
        try { process.kill(status.pid, 0); }
        catch (cause: unknown) { exited = cause instanceof Error && "code" in cause && cause.code === "ESRCH"; }
        if (!exited) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(exited).toBe(true);
    } finally {
      await cleanupTrackedStateOwners([root]);
      owner = undefined;
    }
  });

  test("an owner exits when the worktree build that started it disappears", async () => {
    const executable = join(root, "worktree", ".build", "megabrain");
    mkdirSync(join(root, "worktree", ".build"), { recursive: true });
    writeFileSync(executable, "test build");
    owner = await startStateOwner(root, undefined, { ...process.env, MEGABRAIN_STATE_OWNER_EXECUTABLE: executable });

    rmSync(executable);
    const deadline = Date.now() + 1_500;
    while (!owner.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    expect(owner.stopped).toBe(true);
  });

  test("a write held beyond the client timeout returns its committed outcome", async () => {
    await callStateOwner(root, { operation: "setting-write", key: "warmup", value: "ready" });
    const status = await inspectStateOwner(root);
    if (!status.running) throw new Error("on-demand state owner did not start");
    const blocker = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (blocker.kind !== "ok") throw new Error(blocker.error);
    const lock = spawn(process.execPath, ["-e", [
      'const { Database } = await import("bun:sqlite");',
      'const db = new Database(process.env.MEGABRAIN_LOCK_DB);',
      'db.exec("BEGIN IMMEDIATE");',
      'process.stdout.write("locked");',
      'await new Promise((resolve) => setTimeout(resolve, 100));',
      'db.exec("COMMIT");',
      'db.close();',
    ].join(" ")], { env: { ...process.env, MEGABRAIN_LOCK_DB: blocker.value.path }, stdio: ["ignore", "pipe", "inherit"] });
    const lockClosed = new Promise<void>((resolve) => lock.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        lock.stdout.once("data", () => resolve());
        lock.once("error", reject);
        lock.once("close", (code) => { if (code !== 0) reject(new Error(`lock holder exited with ${code}`)); });
      });
      const pending = callStateOwner(root, { operation: "setting-write", key: "timeout-write", value: "committed" }, 50);
      await expect(pending).resolves.toEqual({ written: true });
      expect(await callStateOwner(root, { operation: "setting-read", key: "timeout-write" })).toEqual({ value: "committed" });
    } finally {
      await lockClosed;
      blocker.value.close();
      try { process.kill(status.pid, "SIGTERM"); } catch { /* owner already exited */ }
    }
  });

  test("different state directories use different owners and never share writes", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "mb-state-owner-other-"));
    let otherOwner: Awaited<ReturnType<typeof startStateOwner>> | undefined;
    try {
      owner = await startStateOwner(root);
      otherOwner = await startStateOwner(otherRoot);
      expect(stateOwnerSocket(root)).not.toBe(stateOwnerSocket(otherRoot));
      expect(owner.server).not.toBe(otherOwner.server);
      expect(owner.handle).not.toBe(otherOwner.handle);
      await callStateOwner(root, { operation: "setting-write", key: "isolation", value: "first" });
      await callStateOwner(otherRoot, { operation: "setting-write", key: "isolation", value: "second" });
      expect(await callStateOwner(root, { operation: "setting-read", key: "isolation" })).toEqual({ value: "first" });
      expect(await callStateOwner(otherRoot, { operation: "setting-read", key: "isolation" })).toEqual({ value: "second" });
    } finally {
      if (otherOwner !== undefined) await stopStateOwner(otherOwner);
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("one typed mail operation commits its message and outbox together", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const written = await callStateOwner(root, {
      operation: "append-message",
      dispatchId: "dispatch-owner",
      message: { from: "child", type: "done", text: "finished", sessionId: "child", createdAt: "2026-10-18T00:00:00.000Z" },
      delivery: { id: "delivery-owner", recipient: "parent", status: "outstanding" },
      outbox: { id: "outbox-owner", targetKind: "parent-pointer", target: "parent", payload: { dispatchId: "dispatch-owner" } },
    });
    expect(written).toEqual({ sequence: 1 });
    const message = await callStateOwner(root, { operation: "message-read", dispatchId: "dispatch-owner", sequence: 1 });
    expect(message).toMatchObject({ from: "child", type: "done", text: "finished" });
    const rows = owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE id = ?").get("outbox-owner");
    expect(rows?.count).toBe(1);
  });

  test("queue mail derives its sequence, recipient, and outbox in the owner transaction", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running", parentSessionId: "parent" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const written = await callStateOwner(root, {
      operation: "append-queue-message",
      dispatchId: "dispatch-owner",
      message: { from: "child", type: "done", text: "finished", sessionId: "child", createdAt: "2026-10-18T00:00:00.000Z" },
      dispatch: { dispatchId: "dispatch-owner", parentSessionId: "parent", agent: "codex" },
    });
    expect(written).toMatchObject({ sequence: 1 });
    const delivery = owner.handle.db.query<{ recipient: string; message_seq: number }>("SELECT json_extract(extra, '$.recipient') AS recipient, message_seq FROM deliveries").get();
    const outbox = owner.handle.db.query<{ target: string; payload: string }>("SELECT target, payload FROM outbox").get();
    expect(delivery).toEqual({ recipient: "parent", message_seq: 1 });
    expect(outbox?.target).toBe("parent");
    expect(outbox?.payload).toContain("mail: megabrain orchestrate watch dispatch-owner");
  });

  test("child ask and done commit their dispatch transitions with their messages", async () => {
    owner = await startStateOwner(root);
    expect(createDispatch(owner.handle, { dispatchId: "owner-atomic-report", state: "running" }).kind).toBe("ok");
    const dispatch = { dispatchId: "owner-atomic-report", state: "running", parentSessionId: "parent" };
    await callStateOwner(root, { operation: "append-queue-message", dispatchId: "owner-atomic-report", dispatch, message: { from: "child", type: "ask", text: "decision", sessionId: "child", createdAt: "2026-10-19T00:00:00.000Z" }, childReport: { type: "ask", agent: "codex" } });
    expect(owner.handle.db.query<{ state: string }>("SELECT state FROM dispatches WHERE id = ?").get("owner-atomic-report")?.state).toBe("waiting_for_reply");
    await callStateOwner(root, { operation: "append-queue-message", dispatchId: "owner-atomic-report", dispatch, message: { from: "child", type: "done", text: "finished", sessionId: "child", createdAt: "2026-10-19T00:00:01.000Z" }, childReport: { type: "done", agent: "codex" } });
    expect(owner.handle.db.query<{ state: string }>("SELECT state FROM dispatches WHERE id = ?").get("owner-atomic-report")?.state).toBe("done");
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM messages WHERE dispatch_id = ? AND type IN ('ask', 'done')").get("owner-atomic-report")?.count).toBe(2);
  });

  test("each new done event creates fresh parent mail, including identical text", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running", parentSessionId: "parent" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const append = (text: string) => callStateOwner(root, {
      operation: "append-queue-message",
      dispatchId: "dispatch-owner",
      message: { from: "child", type: "done", text, sessionId: "child", createdAt: new Date().toISOString() },
      dispatch: { dispatchId: "dispatch-owner", parentSessionId: "parent", agent: "codex" },
    });
    await append("finished the first part");
    await append("finished the updated report");
    await append("finished the updated report");
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE dispatch_id = ?").get("dispatch-owner")?.count).toBe(3);
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM messages WHERE dispatch_id = ? AND type = 'done'").get("dispatch-owner")?.count).toBe(3);
  });

  test("a later done event with the same text creates parent mail while replay stays idempotent", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-repeat-done", state: "running", parentSessionId: "parent" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const event = {
      operation: "append-queue-message" as const,
      dispatchId: "dispatch-repeat-done",
      message: { from: "child", type: "done", text: "finished", sessionId: "child", createdAt: "2026-10-19T00:00:00.000Z" },
      dispatch: { dispatchId: "dispatch-repeat-done", parentSessionId: "parent", agent: "codex" },
    };
    await callStateOwner(root, { ...event, requestId: "done-event-first" });
    await callStateOwner(root, { ...event, requestId: "done-event-first" });
    await callStateOwner(root, { ...event, requestId: "done-event-second", message: { ...event.message, createdAt: "2026-10-19T00:00:01.000Z" } });
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE dispatch_id = ?").get("dispatch-repeat-done")?.count).toBe(2);
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM messages WHERE dispatch_id = ? AND type = 'done'").get("dispatch-repeat-done")?.count).toBe(2);
  });

  test("delivery claims and acknowledgements are serialized by the owner", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    await callStateOwner(root, {
      operation: "append-message",
      dispatchId: "dispatch-owner",
      message: { from: "child", type: "ask", text: "question", sessionId: "child" },
      delivery: { id: "delivery-claim", recipient: "parent", status: "outstanding" },
    });
    const claim = await callStateOwner(root, { operation: "claim-delivery", id: "delivery-claim", consumer: "parent", generation: 3 });
    expect(claim).toMatchObject({ id: "delivery-claim", consumer: "parent", consumerGeneration: 3 });
    expect(await callStateOwner(root, { operation: "ack-delivery", id: "delivery-claim", consumer: "parent", generation: 3 })).toEqual({ duplicate: false });
    expect(owner.handle.db.query<{ status: string }>("SELECT status FROM deliveries WHERE id = ?").get("delivery-claim")?.status).toBe("acknowledged");
  });

  test("parent replies and watch waiters are committed through owner operations", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const reply = await callStateOwner(root, {
      operation: "append-parent-reply",
      dispatchId: "dispatch-owner",
      message: { from: "parent", type: "reply", text: "use the stable branch", sessionId: "parent" },
      options: { supersede: false },
    });
    expect(reply).toMatchObject({ seq: 1, from: "parent", type: "reply" });
    const delivered = owner.handle.db.query<{ recipient: string; status: string }>("SELECT json_extract(extra, '$.recipient') AS recipient, status FROM deliveries").get();
    expect(delivered).toEqual({ recipient: "child", status: "outstanding" });
    await callStateOwner(root, { operation: "put-waiter", waiter: { dispatchId: "dispatch-owner", pid: process.pid, parentSessionId: "parent", parentHost: "local", createdAt: "2026-10-18T00:00:00.000Z" } });
    expect(owner.handle.db.query<{ pid: number }>("SELECT pid FROM waiters WHERE dispatch_id = ?").get("dispatch-owner")?.pid).toBe(process.pid);
    expect(await callStateOwner(root, { operation: "delete-waiter", dispatchId: "dispatch-owner" })).toBe(true);
  });

  test("child ask and receipt reports update dispatch state in the owner", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running", processState: "starting" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "child-report", dispatchId: "dispatch-owner", type: "received", agent: "claude", claudeSessionId: "session-1" });
    const received = owner.handle.db.query<{ state: string; process_state: string; prompt_state: string; agent_session_id: string }>("SELECT state, json_extract(extra, '$.processState') AS process_state, json_extract(extra, '$.promptState') AS prompt_state, json_extract(extra, '$.agentSessionId') AS agent_session_id FROM dispatches WHERE id = ?").get("dispatch-owner");
    expect(received).toEqual({ state: "running", process_state: "running", prompt_state: "confirmed", agent_session_id: "session-1" });
    await callStateOwner(root, { operation: "child-report", dispatchId: "dispatch-owner", type: "ask" });
    expect(owner.handle.db.query<{ state: string }>("SELECT state FROM dispatches WHERE id = ?").get("dispatch-owner")?.state).toBe("waiting_for_reply");
  });

  test("dispatch patches are applied by the owner", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "spawning", reason: "starting" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId: "dispatch-owner", patch: { state: "running", processState: "running", reason: null } });
    const row = owner.handle.db.query<{ state: string; process_state: string; reason: string | null }>("SELECT state, json_extract(extra, '$.processState') AS process_state, json_extract(extra, '$.reason') AS reason FROM dispatches WHERE id = ?").get("dispatch-owner");
    expect(row).toEqual({ state: "running", process_state: "running", reason: null });
  });

  test("dispatch patches can require the state observed by the caller", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running" }).kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const skipped = await callStateOwner(root, { operation: "dispatch-patch", dispatchId: "dispatch-owner", expectedState: "queued", patch: { state: "failed" } });
    expect(skipped).toMatchObject({ updated: false });
    expect(owner.handle.db.query<{ state: string }>("SELECT state FROM dispatches WHERE id = ?").get("dispatch-owner")?.state).toBe("running");
  });

  test("dispatch creation is applied by the owner", async () => {
    owner = await startStateOwner(root);
    const created = await callStateOwner(root, { operation: "dispatch-create", dispatch: { dispatchId: "dispatch-owner", state: "spawning", agent: "codex" } });
    expect(created).toMatchObject({ dispatchId: "dispatch-owner", state: "spawning" });
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM dispatches WHERE id = ?").get("dispatch-owner")?.count).toBe(1);
  });

  test("install state writes are applied by the owner", async () => {
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "install-state-write", moduleId: "machineInstall", value: { installed: true } });
    const row = owner.handle.db.query<{ value: string }>("SELECT value FROM install_state WHERE module_id = ?").get("machineInstall");
    expect(JSON.parse(row?.value ?? "null")).toEqual({ installed: true });
  });

  test("hidden worktree records are written by the owner", async () => {
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "hidden-item-write", kind: "worktree", path: "/worktree/a", hidden: true });
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM hidden_items WHERE kind = 'worktree' AND path = ?").get("/worktree/a")?.count).toBe(1);
    await callStateOwner(root, { operation: "hidden-item-write", kind: "worktree", path: "/worktree/a", hidden: false });
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM hidden_items WHERE kind = 'worktree' AND path = ?").get("/worktree/a")?.count).toBe(0);
  });

  test("tmux session cleanup is serialized by the owner", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    const saved = putTmuxSession(seeded.value, { tmuxSession: "owner-tmux" }, null);
    if (saved.kind !== "ok") throw new Error(saved.error);
    seeded.value.close();
    owner = await startStateOwner(root);

    expect(await callStateOwner(root, { operation: "tmux-session-write", action: "remove", session: "owner-tmux" })).toEqual({ written: true });

    const read = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (read.kind !== "ok") throw new Error(read.error);
    expect(getTmuxSession(read.value, "owner-tmux").value).toBeUndefined();
    read.value.close();
    expect(readFileSync(join(root, "logs", "state-owner.log"), "utf8")).toContain('"operation":"tmux-session-write"');
  });

  test("worktree registration and completion are serialized by the owner", async () => {
    owner = await startStateOwner(root);
    const worktree = { path: "/worktree/b", repo: "/repo", repoName: "repo", branch: "feature/b", createdAt: "2026-10-18T00:00:00.000Z", createdBy: "codex", purpose: "task", origin: "created" as const, finishedAt: null, parentBranch: null };
    await callStateOwner(root, { operation: "worktree-write", action: "upsert", worktree });
    expect(owner.handle.db.query<{ branch: string }>("SELECT branch FROM worktrees WHERE path = ?").get(worktree.path)?.branch).toBe("feature/b");
    expect(await callStateOwner(root, { operation: "worktree-write", action: "finish", path: worktree.path, finishedAt: "2026-10-18T01:00:00.000Z" })).toEqual({ updated: true });
    expect(owner.handle.db.query<{ finished_at: string }>("SELECT finished_at FROM worktrees WHERE path = ?").get(worktree.path)?.finished_at).toBe("2026-10-18T01:00:00.000Z");
    expect(await callStateOwner(root, { operation: "worktree-write", action: "reopen", path: worktree.path })).toEqual({ updated: true });
    expect(owner.handle.db.query<{ finished_at: string | null }>("SELECT finished_at FROM worktrees WHERE path = ?").get(worktree.path)?.finished_at).toBeNull();
  });

  test("repository registration and removal are serialized by the owner", async () => {
    owner = await startStateOwner(root);
    const repository = { name: "repo", path: "/repo", remote: null, source: "megabrain" as const, addedAt: "2026-10-18T00:00:00.000Z" };
    expect(await callStateOwner(root, { operation: "repository-register", repository })).toEqual(repository);
    expect(await callStateOwner(root, { operation: "repository-remove", path: repository.path })).toEqual(repository);
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM repositories WHERE path = ?").get(repository.path)?.count).toBe(0);
  });

  test("repository pull request cache writes are serialized by the owner", async () => {
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "repository-register", repository: { name: "repo", path: "/repo", remote: null, source: "megabrain", addedAt: "2026-10-18T00:00:00.000Z" } });
    await callStateOwner(root, { operation: "repository-pull-request-cache-write", path: "/repo", value: "[]", fetchedAt: 1_800_000_000_000 });
    expect(owner.handle.db.query<{ value_json: string; fetched_at: number }>("SELECT value_json, fetched_at FROM repository_pull_requests WHERE repository_path = ?").get("/repo"))
      .toEqual({ value_json: "[]", fetched_at: 1_800_000_000_000 });
  });

  test("project history backfill writes repositories and its marker atomically", async () => {
    owner = await startStateOwner(root);
    const repository = { name: "repo", path: "/repo", remote: null, source: "megabrain" as const, addedAt: "2026-10-18T00:00:00.000Z" };
    expect(await callStateOwner(root, { operation: "project-history-backfill", markerKey: "history-test", markedAt: repository.addedAt, repositories: [repository] })).toEqual({ written: true });
    expect(owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM repositories WHERE path = ?").get(repository.path)?.count).toBe(1);
    expect(owner.handle.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get("history-test")?.value).toBe(repository.addedAt);
  });

  test("delivery channel results are recorded by the owner", async () => {
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "channel-result", result: { agent: "codex", channel: "codex-queue", agentVersion: "unknown", ok: true, now: 1_800_000_000_000 } });
    const row = owner.handle.db.query<{ status: string; failures: number }>("SELECT status, failures FROM delivery_channels WHERE agent = ? AND channel = ?").get("codex", "codex-queue");
    expect(row).toEqual({ status: "working", failures: 0 });
  });

  test("resource samples are written by the owner", async () => {
    owner = await startStateOwner(root);
    const samples = await callStateOwner(root, {
      operation: "resource-samples",
      samples: [{ dispatchId: "dispatch-owner", agent: "codex", rssBytes: 2048, cpuPercent: 12.5 }],
      now: 1_800_000_000_000,
    });
    expect(samples).toBe(1);
    expect(owner.handle.db.query<{ rss_bytes: number; cpu_percent: number }>("SELECT rss_bytes, cpu_percent FROM resource_samples WHERE dispatch_id = ?").get("dispatch-owner"))
      .toEqual({ rss_bytes: 2048, cpu_percent: 12.5 });
  });

  test("owner leases serialize one delivery target", async () => {
    owner = await startStateOwner(root);
    expect(await callStateOwner(root, { operation: "acquire-lease", key: "delivery-target:child", holder: "first", seconds: 60 })).toBe(true);
    expect(await callStateOwner(root, { operation: "acquire-lease", key: "delivery-target:child", holder: "second", seconds: 60 })).toBe(false);
    expect(await callStateOwner(root, { operation: "release-lease", key: "delivery-target:child", holder: "first" })).toBe(true);
  });

  test("leases can be transferred by the owner", async () => {
    owner = await startStateOwner(root);
    expect(await callStateOwner(root, { operation: "acquire-lease", key: "supervise", holder: "starter", seconds: 90 })).toBe(true);
    expect(await callStateOwner(root, { operation: "transfer-lease", key: "supervise", from: "starter", to: "worker" })).toBe(true);
    expect(await callStateOwner(root, { operation: "release-lease", key: "supervise", holder: "starter" })).toBe(false);
    expect(await callStateOwner(root, { operation: "release-lease", key: "supervise", holder: "worker" })).toBe(true);
  });

  test("a restarted owner resumes a pending outbox row", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    expect(seeded.kind).toBe("ok");
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-owner", state: "running" }).kind).toBe("ok");
    const inserted = withWrite(seeded.value, (db) => insertOutbox(db, {
      id: "outbox-resume", dispatchId: "dispatch-owner", targetKind: "parent-pointer", target: "local:",
      payload: { dispatchId: "dispatch-owner", targetKind: "parent-pointer", sequence: 1, meta: { dispatchId: "dispatch-owner", parentHost: "local", targetKind: "parent-pointer" }, fullMessage: "mail: megabrain orchestrate watch dispatch-owner" },
      status: "pending", attempts: 0, leaseUntil: null, transport: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    expect(inserted.kind).toBe("ok");
    seeded.value.close();
    owner = await startStateOwner(root);
    const deadline = Date.now() + 5_000;
    let status = "pending";
    while (Date.now() < deadline && (status === "pending" || status === "sending")) {
      status = owner.handle.db.query<{ status: string }>("SELECT status FROM outbox WHERE id = ?").get("outbox-resume")?.status ?? "missing";
      if (status === "pending" || status === "sending") await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(["sent", "failed", "suppressed"]).toContain(status);
  });

  test("a crashed owner replays a write committed before its reply was lost", async () => {
    const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    expect(createDispatch(seeded.value, { dispatchId: "dispatch-idempotent", state: "running" }).kind).toBe("ok");
    seeded.value.close();
    const entry = join(import.meta.dir, "../../src/cli/index.ts");
    const child = spawn(process.execPath, [entry, "__state-owner"], {
      env: {
        ...process.env,
        MEGABRAIN_STATE_OWNER_DIR: root,
        MEGABRAIN_STATE_DIR: root,
        MEGABRAIN_STATE_OWNER_IDLE_MS: "60000",
      },
      stdio: "ignore",
    });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const request = {
      requestId: "request-after-lost-reply",
      operation: "append-message" as const,
      dispatchId: "dispatch-idempotent",
      message: { from: "child", type: "ask", text: "once", sessionId: "child", createdAt: "2026-10-18T00:00:00.000Z" },
    };
    const read = openDatabase({ MEGABRAIN_STATE_DIR: root });
    if (read.kind !== "ok") throw new Error(read.error);
    try {
      const readyDeadline = Date.now() + 5_000;
      let running = await inspectStateOwner(root);
      while (!running.running && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        running = await inspectStateOwner(root);
      }
      if (!running.running) throw new Error("state owner child did not start");
      const socket = createConnection(stateOwnerSocket(root));
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          socket.write(JSON.stringify(request) + "\n", () => { socket.destroy(); resolve(); });
        });
        socket.once("error", reject);
      });
      const commitDeadline = Date.now() + 5_000;
      let stored = 0;
      while (stored === 0 && Date.now() < commitDeadline) {
        stored = read.value.db.query<{ count: number }>("SELECT count(*) AS count FROM state_owner_requests WHERE request_id = ?").get(request.requestId)?.count ?? 0;
        if (stored === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stored).toBe(1);
      process.kill(child.pid, "SIGKILL");
      const stopDeadline = Date.now() + 5_000;
      let runningAfterCrash = await inspectStateOwner(root);
      while (runningAfterCrash.running && Date.now() < stopDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        runningAfterCrash = await inspectStateOwner(root);
      }
      expect(runningAfterCrash.running).toBe(false);
      const replay = await callStateOwner(root, request);
      expect(replay).toEqual({ sequence: 1 });
      expect(read.value.db.query<{ count: number }>("SELECT count(*) AS count FROM messages WHERE dispatch_id = ?").get("dispatch-idempotent")?.count).toBe(1);
    } finally {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* owner already exited */ }
      await childClosed;
      read.value.close();
    }
  });

  test("a committed write survives owner restart", async () => {
    owner = await startStateOwner(root);
    await callStateOwner(root, { operation: "setting-write", key: "owner-test", value: "durable" });
    await stopStateOwner(owner);
    owner = await startStateOwner(root);

    const read = await callStateOwner(root, { operation: "setting-read", key: "owner-test" });
    expect(read).toEqual({ value: "durable" });
  });
});
