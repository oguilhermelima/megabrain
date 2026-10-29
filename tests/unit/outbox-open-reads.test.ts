import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listClosedParentOutboxDispatchIds,
  listOpenOutbox,
} from "../../src/adapters/state/mailbox.js";
import { guardedOpenDatabase } from "./state-db-guard.js";

const root = mkdtempSync(join(tmpdir(), "megabrain-open-outbox-"));
process.env.MEGABRAIN_STATE_DIR = join(root, "state");
const opened = guardedOpenDatabase({
  MEGABRAIN_STATE_DIR: process.env.MEGABRAIN_STATE_DIR,
});
if (opened.kind !== "ok") throw new Error(opened.error);
const handle = opened.value;

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
  });

  test("returns only old pending and sending notices", () => {
    const prefix = `status-${Date.now()}`;
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
  });
});

afterAll(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});
