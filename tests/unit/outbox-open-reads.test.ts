import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatch } from "../../src/adapters/state/dispatches.js";
import {
  closedParentOutboxDispatchIdsSql,
  listClosedParentOutboxDispatchIds,
  listOpenOutbox,
  openOutboxSql,
} from "../../src/adapters/state/mailbox.js";
import { ensureOutboxIndexes } from "../../src/db/state-owner.js";
import { guardedOpenDatabase } from "./state-db-guard.js";

const root = mkdtempSync(join(tmpdir(), "megabrain-open-outbox-"));
process.env.MEGABRAIN_STATE_DIR = join(root, "state");
const opened = guardedOpenDatabase({
  MEGABRAIN_STATE_DIR: process.env.MEGABRAIN_STATE_DIR,
});
if (opened.kind !== "ok") throw new Error(opened.error);
const handle = opened.value;
ensureOutboxIndexes(handle.db);

function createDispatchRecord(dispatchId: string): void {
  const result = createDispatch(handle, {
    dispatchId,
    agent: "codex",
    parentHost: "tmux",
    parentSessionId: "test-session",
    state: "closed",
  });
  if (result.kind !== "ok") throw new Error(result.error);
}

function expectIndexedQuery(
  sql: string,
  ...parameters: (string | number | null)[]
): void {
  const plan = handle.db
    .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters);
  expect(plan.map((row) => row.detail).join("\n")).not.toMatch(
    /SCAN outbox\b/i,
  );
}

function insert(
  id: string,
  dispatchId: string | null,
  kind: string,
  status: string,
  detail: string | null,
  createdAt: string,
): void {
  handle.db.run(
    "INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail) VALUES (?, ?, ?, ?, '{}', ?, 0, NULL, NULL, ?, ?, NULL, ?)",
    [id, dispatchId, kind, id, status, createdAt, createdAt, detail],
  );
}

describe("scoped outbox reads", () => {
  test("finds only parent dispatches whose rows supersedeClosedParentDeliveries can change", () => {
    const prefix = `parent-${Date.now()}`;
    for (const suffix of [
      "pending",
      "sending",
      "verify",
      "done",
      "failed",
      "other-kind",
    ])
      createDispatchRecord(`${prefix}-${suffix}`);
    insert(
      `${prefix}-pending`,
      `${prefix}-pending`,
      "parent-pointer",
      "pending",
      null,
      "2026-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-sending`,
      `${prefix}-sending`,
      "parent-pointer",
      "sending",
      null,
      "2026-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-verify`,
      `${prefix}-verify`,
      "parent-pointer",
      "sent",
      'peer-verification:{"state":"fallback-queued"}',
      "2026-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-done`,
      `${prefix}-done`,
      "parent-pointer",
      "sent",
      'peer-verification:{"state":"complete"}',
      "2026-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-failed`,
      `${prefix}-failed`,
      "parent-pointer",
      "failed",
      null,
      "2026-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-other-kind`,
      `${prefix}-other-kind`,
      "notification",
      "pending",
      null,
      "2026-01-01T00:00:00.000Z",
    );

    const result = listClosedParentOutboxDispatchIds(handle);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok")
      expect(result.value.filter((id) => id.startsWith(prefix)).sort()).toEqual(
        [`${prefix}-pending`, `${prefix}-sending`, `${prefix}-verify`],
      );
    expectIndexedQuery(closedParentOutboxDispatchIdsSql);
  });

  test("returns only old pending and sending notices", () => {
    const prefix = `status-${Date.now()}`;
    for (const suffix of ["pending", "sending", "sent", "recent"])
      createDispatchRecord(`${prefix}-${suffix}`);
    insert(
      `${prefix}-pending`,
      `${prefix}-pending`,
      "notice",
      "pending",
      null,
      "2020-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-sending`,
      `${prefix}-sending`,
      "notice",
      "sending",
      null,
      "2020-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-sent`,
      `${prefix}-sent`,
      "notice",
      "sent",
      null,
      "2020-01-01T00:00:00.000Z",
    );
    insert(
      `${prefix}-recent`,
      `${prefix}-recent`,
      "notice",
      "pending",
      null,
      new Date().toISOString(),
    );
    insert(
      `${prefix}-no-dispatch`,
      null,
      "notice",
      "pending",
      null,
      "2020-01-01T00:00:00.000Z",
    );

    const result = listOpenOutbox(
      handle,
      new Date(Date.now() - 30_000).toISOString(),
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok")
      expect(
        result.value
          .filter((item) => item.id.startsWith(prefix))
          .map((item) => item.id)
          .sort(),
      ).toEqual([`${prefix}-pending`, `${prefix}-sending`]);
    expectIndexedQuery(
      openOutboxSql,
      new Date(Date.now() - 30_000).toISOString(),
    );
  });
});

afterAll(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});
