import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readJsonStateParity, importJsonState } from "../../src/db/import/json-state.js";
import { insertDispatch, getDispatch, updateDispatch } from "../../src/db/queries/dispatches.js";
import { insertMessage, listMessages } from "../../src/db/queries/messages.js";
import { insertDelivery, listDeliveries } from "../../src/db/queries/deliveries.js";

type SqlValue = string | number | bigint | null | Uint8Array;
type TestDatabase = {
  run(sql: string, parameters?: readonly SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  query<T>(sql: string): { all(): T[]; get(...parameters: SqlValue[]): T | null };
};

let current: { directory: string; sqlite: InstanceType<typeof Database>; db: TestDatabase } | undefined;

async function database(): Promise<{ directory: string; db: TestDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), "megabrain-dispatch-db-"));
  const sqlite = new Database(":memory:");
  const db: TestDatabase = {
    run(sql, parameters) {
      const result = parameters === undefined ? (sqlite.exec(sql), { changes: 0, lastInsertRowid: 0 }) : sqlite.query(sql).run(...parameters);
      return { changes: Number(result.changes ?? 0), lastInsertRowid: result.lastInsertRowid ?? 0 };
    },
    query: <T>(sql: string) => {
      const statement = sqlite.query(sql);
      return { all: () => statement.all() as T[], get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null };
    },
  };
  const schema = await readFile(new URL("../../src/db/schema/002-dispatch-core.sql", import.meta.url), "utf8");
  sqlite.exec(schema);
  current = { directory, sqlite, db };
  return { directory, db };
}

afterEach(async () => {
  current?.sqlite.close();
  if (current !== undefined) await rm(current.directory, { recursive: true, force: true });
  current = undefined;
});

const meta = (id: string, state = "running") => ({
  dispatchId: id,
  parentSessionId: "parent-session",
  parentHost: "codex",
  parentTerminalId: "terminal-parent",
  childHost: "tmux",
  terminalId: "tmux:session:%1",
  worktreePath: "/tmp/worktree",
  branch: "feat/example",
  agent: "codex",
  model: "gpt-6-sol",
  effort: "high",
  runtime: "tmux",
  tmuxSessionId: "$7",
  tmuxSession: "session",
  tmuxPane: "%1",
  state,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  extension: { preserved: true },
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

describe("dispatch state schema and JSON import", () => {
  test("imports live and archived state, reports malformed files and collisions, and is idempotent", async () => {
    const { directory, db } = await database();
    const stateDir = join(directory, "state");
    const liveId = "dispatch-live";
    const archivedId = "dispatch-archived";
    const live = meta(liveId);
    const archived = { ...meta(archivedId, "done"), archivedMarker: true };
    await writeJson(join(stateDir, "dispatches", liveId, "meta.json"), live);
    await writeJson(join(stateDir, "dispatches", "archive", "2026-09", archivedId, "meta.json"), archived);
    await writeJson(join(stateDir, "dispatches", "archive", "2026-09", liveId, "meta.json"), { ...meta(liveId, "closed"), archivedCollision: true });
    await mkdir(join(stateDir, "dispatches", liveId, "messages"), { recursive: true });
    const messages = [1, 2, 3].map((seq) => ({ seq, from: seq === 1 ? "parent" : "child", type: seq === 1 ? "prompt" : "message", text: `message ${seq}`, sessionId: "session-1", createdAt: `2026-09-01T00:00:0${seq}.000Z`, ...(seq === 1 ? { idempotencyKey: "prompt-once" } : {}) }));
    for (const message of messages) await writeJson(join(stateDir, "dispatches", liveId, "messages", `${message.seq}-message.json`), message);
    const deliveries = [
      { id: "delivery-open", dispatchId: liveId, recipient: "child", messageSeqs: [1], status: "outstanding", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null },
      { id: "delivery-acked", dispatchId: liveId, recipient: "parent", messageSeqs: [2, 3], status: "acknowledged", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:01:00.000Z", acknowledgedAt: "2026-09-01T00:01:00.000Z", fencedAt: null, consumer: "child/codex/session/%1", consumerGeneration: 1 },
    ];
    for (const delivery of deliveries) await writeJson(join(stateDir, "dispatches", liveId, "deliveries", `${delivery.id}.json`), delivery);
    await mkdir(join(stateDir, "dispatches", "broken"), { recursive: true });
    await writeFile(join(stateDir, "dispatches", "broken", "meta.json"), "{bad json\n");
    await writeJson(join(stateDir, "terminals", "terminal-1.json"), { terminalId: "terminal-1", host: "orca", workspaceId: null, worktree: "/tmp/worktree", title: "DEV", command: "bun run dev", createdAt: "2026-09-01T00:00:00.000Z", pid: null, rootPid: null, port: null, status: "active" });
    await writeJson(join(stateDir, "state.json"), { "tmux-runtime": { installed: true }, machineInstall: { modules: ["tmux-runtime"] } });
    await writeJson(join(stateDir, "models.json"), { version: 1, models: [{ agent: "codex", model: "gpt-6-sol", reasoning: { separateAxis: true, levels: ["high"] }, provenance: { kind: "curated" } }] });
    await writeJson(join(stateDir, "sessions", "session.json"), { tmuxSession: "session", tmuxPane: "%1", agent: "codex", workingDirectory: "/tmp/worktree", createdAt: "2026-09-01T00:00:00.000Z" });

    const firstImport = await importJsonState(db, stateDir);
    expect(firstImport.skippedMalformed).toHaveLength(1);
    expect(firstImport.collisions.map((collision) => collision.id)).toEqual([liveId]);
    const parity = await readJsonStateParity(db, stateDir);
    expect(parity.mismatches).toEqual([]);
    expect(parity.totals.dispatches).toBe(2);
    expect(parity.totals.messages).toBe(3);
    expect(parity.totals.deliveries).toBe(2);
    expect(parity.records.dispatches.find((record) => record.dispatchId === liveId)).toEqual(live);
    expect(listMessages(db, liveId).map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(listDeliveries(db, liveId).map((delivery) => delivery.id)).toEqual(["delivery-acked", "delivery-open"]);

    const secondImport = await importJsonState(db, stateDir);
    expect(secondImport.inserted).toEqual({ dispatches: 0, messages: 0, deliveries: 0, terminals: 0, installState: 0, models: 0, tmuxSessions: 0 });
    expect((await readJsonStateParity(db, stateDir)).mismatches).toEqual([]);
  });

  test("enforces state, sequence and idempotency constraints and cascades dispatch deletes", async () => {
    const { db } = await database();
    const valid = meta("constraint-test");
    expect(insertDispatch(db, valid).kind).toBe("inserted");
    expect(() => insertDispatch(db, meta("invalid-state", "not-a-state"))).toThrow();
    const message = { seq: 1, from: "parent", type: "reply", text: "hello", sessionId: "s", createdAt: "now", idempotencyKey: "same-key" };
    insertMessage(db, "constraint-test", message);
    expect(() => insertMessage(db, "constraint-test", message)).toThrow();
    expect(() => insertMessage(db, "constraint-test", { ...message, seq: 2 })).toThrow();
    insertDelivery(db, { id: "cascade-delivery", dispatchId: "constraint-test", recipient: "child", messageSeqs: [1], status: "outstanding", createdAt: "now", updatedAt: "now", acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
    db.run("DELETE FROM dispatches WHERE id = ?", ["constraint-test"]);
    expect(listMessages(db, "constraint-test")).toEqual([]);
    expect(listDeliveries(db, "constraint-test")).toEqual([]);
  });

  test("reports optimistic concurrency conflicts for stale dispatch versions", async () => {
    const { db } = await database();
    insertDispatch(db, meta("version-test"));
    expect(updateDispatch(db, "version-test", 0, { state: "waiting_for_reply" })).toMatchObject({ kind: "updated", version: 1 });
    expect(updateDispatch(db, "version-test", 0, { state: "done" })).toEqual({ kind: "conflict", currentVersion: 1 });
    expect(getDispatch(db, "version-test")?.state).toBe("waiting_for_reply");
  });
});
