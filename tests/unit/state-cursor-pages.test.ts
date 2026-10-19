import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { insertDispatch, listDispatches, listDispatchesPage } from "../../src/db/queries/dispatches.js";
import { insertOutbox, listOutbox, listOutboxPage } from "../../src/db/queries/outbox-leases.js";
import { listRepositories, listRepositoriesPage, registerRepository } from "../../src/db/queries/repositories.js";

let stateDir: string;

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "megabrain-cursor-pages-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

describe("state cursor pagination", () => {
  test("dispatch and outbox lists return every row across page boundaries", () => {
    const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      const inserted = withWrite(opened.value, (db) => {
        for (let index = 0; index < 260; index += 1) {
          const id = `cursor-${String(index).padStart(3, "0")}`;
          const createdAt = new Date(1_800_000_000_000 + index).toISOString();
          insertDispatch(db, { dispatchId: id, state: "running", createdAt });
          insertOutbox(db, { id: `outbox-${id}`, dispatchId: id, targetKind: "test", target: "test", payload: {}, status: "sent", attempts: 1, leaseUntil: null, transport: null, createdAt, updatedAt: createdAt });
          registerRepository(db, { name: `repo-${String(index).padStart(3, "0")}`, path: `/repo/${index}`, remote: null, source: "megabrain", addedAt: createdAt });
        }
      });
      expect(inserted.kind).toBe("ok");
      const dispatches = listDispatches(opened.value.db);
      const outbox = listOutbox(opened.value.db);
      expect(dispatches).toHaveLength(260);
      expect(new Set(dispatches.map((row) => row.dispatchId)).size).toBe(260);
      expect(outbox).toHaveLength(260);
      expect(new Set(outbox.map((row) => row.id)).size).toBe(260);
      expect(dispatches[0]?.dispatchId).toBe("cursor-000");
      expect(dispatches.at(-1)?.dispatchId).toBe("cursor-259");
      expect(outbox[0]?.id).toBe("outbox-cursor-000");
      expect(outbox.at(-1)?.id).toBe("outbox-cursor-259");
      const firstDispatchPage = listDispatchesPage(opened.value.db, { limit: 100 });
      const secondDispatchPage = listDispatchesPage(opened.value.db, { limit: 100, after: firstDispatchPage.nextCursor });
      const thirdDispatchPage = listDispatchesPage(opened.value.db, { limit: 100, after: secondDispatchPage.nextCursor });
      expect([firstDispatchPage.rows.length, secondDispatchPage.rows.length, thirdDispatchPage.rows.length]).toEqual([100, 100, 60]);
      const firstOutboxPage = listOutboxPage(opened.value.db, { limit: 100 });
      const secondOutboxPage = listOutboxPage(opened.value.db, { limit: 100, after: firstOutboxPage.nextCursor });
      const thirdOutboxPage = listOutboxPage(opened.value.db, { limit: 100, after: secondOutboxPage.nextCursor });
      expect([firstOutboxPage.rows.length, secondOutboxPage.rows.length, thirdOutboxPage.rows.length]).toEqual([100, 100, 60]);
      const firstRepositoryPage = listRepositoriesPage(opened.value.db, { limit: 100 });
      const secondRepositoryPage = listRepositoriesPage(opened.value.db, { limit: 100, after: firstRepositoryPage.nextCursor });
      const thirdRepositoryPage = listRepositoriesPage(opened.value.db, { limit: 100, after: secondRepositoryPage.nextCursor });
      expect([firstRepositoryPage.rows.length, secondRepositoryPage.rows.length, thirdRepositoryPage.rows.length]).toEqual([100, 100, 60]);
      expect(listRepositories(opened.value.db)).toHaveLength(260);
    } finally {
      opened.value.close();
    }
  });

  test("dispatch cursors continue from a null creation timestamp", () => {
    const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(withWrite(opened.value, (db) => {
        insertDispatch(db, { dispatchId: "null-created-at", state: "running" });
        insertDispatch(db, { dispatchId: "dated", state: "running", createdAt: "2026-10-19T00:00:00.000Z" });
      }).kind).toBe("ok");
      const first = listDispatchesPage(opened.value.db, { limit: 1 });
      expect(first.rows[0]?.dispatchId).toBe("null-created-at");
      const second = listDispatchesPage(opened.value.db, { limit: 1, after: first.nextCursor });
      expect(second.rows.map((row) => row.dispatchId)).toEqual(["dated"]);
    } finally {
      opened.value.close();
    }
  });
});
