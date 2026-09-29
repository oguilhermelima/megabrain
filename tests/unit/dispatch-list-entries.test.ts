import { guardedStateDatabase } from "./state-db-guard.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { archiveDispatch, createDispatch, listDispatchEntries } from "../../src/adapters/state-db.js";

let stateDirectory = "";
const environment = (): { MEGABRAIN_STATE_DIR: string } => ({ MEGABRAIN_STATE_DIR: stateDirectory });

function requireOk<T>(result: { kind: "ok"; value: T } | { kind: string; error?: string }): T {
  if (result.kind !== "ok") throw new Error(result.error ?? `expected ok, received ${result.kind}`);
  return result.value;
}

beforeEach(() => {
  stateDirectory = mkdtempSync(resolve(tmpdir(), "megabrain-dispatch-entries-"));
});

afterEach(() => {
  rmSync(stateDirectory, { recursive: true, force: true });
});

describe("listDispatchEntries", () => {
  test("returns each record with archive status from the same listing", () => {
    const database = requireOk(guardedStateDatabase(environment()));
    requireOk(createDispatch(database, { dispatchId: "live", state: "running" }));
    requireOk(createDispatch(database, { dispatchId: "archived", state: "done" }));
    requireOk(archiveDispatch(database, "archived", "2026-09-01T00:00:00.000Z"));

    const entries = requireOk(listDispatchEntries(database, { includeArchived: true }));
    expect(entries).toEqual([
      { record: expect.objectContaining({ dispatchId: "archived", state: "done" }), archived: true },
      { record: expect.objectContaining({ dispatchId: "live", state: "running" }), archived: false },
    ]);
  });

  test("uses the same default live-only filter as listDispatches", () => {
    const database = requireOk(guardedStateDatabase(environment()));
    requireOk(createDispatch(database, { dispatchId: "live", state: "running" }));
    requireOk(createDispatch(database, { dispatchId: "archived", state: "done" }));
    requireOk(archiveDispatch(database, "archived"));

    expect(requireOk(listDispatchEntries(database)).map((entry) => entry.record.dispatchId)).toEqual(["live"]);
  });
});
