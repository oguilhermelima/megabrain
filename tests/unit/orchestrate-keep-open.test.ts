import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { guardedStateDatabase } from "./state-db-guard.js";
import { createDispatch, getDispatch } from "../../src/adapters/state-db.js";
import { executeOrchestrateKeepOpen } from "../../src/cli/commands/orchestrate-keep-open.js";
import { failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import type { DatabaseHandle } from "../../src/db/db.js";

let root = "";
let database: DatabaseHandle | undefined;
afterEach(async () => { database?.close(); database = undefined; if (root !== "") await rm(root, { recursive: true, force: true }); root = ""; });

const process: ProcessAdapter = {
  run: async () => failed("unexpected process call"),
  startDetached: async () => failed("unexpected process call"),
  invocationCount: () => 0,
};

describe("orchestrate keep-open", () => {
  test("marks a dispatch to stay open", async () => {
    root = await mkdtemp(`${tmpdir()}/megabrain-keep-open-`);
    const opened = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (opened.kind !== "ok") throw new Error(opened.error);
    database = opened.value;
    const created = createDispatch(database, { dispatchId: "dispatch-keep", state: "done", runtime: "tmux" });
    if (created.kind !== "ok") throw new Error(created.error);
    const result = await executeOrchestrateKeepOpen(["keep"], { MEGABRAIN_STATE_DIR: root }, process);
    expect(result).toMatchObject({ kind: "ok" });
    expect(getDispatch(database, "dispatch-keep")).toMatchObject({ kind: "ok", value: { keepOpen: true } });
  });
});
