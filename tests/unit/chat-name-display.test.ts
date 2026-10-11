import { describe, expect, test } from "bun:test";
import { formatDispatchList } from "../../src/core/dispatch.js";
import { executeDatabase } from "../../src/cli/commands/db.js";
import { executeOrchestrateList } from "../../src/cli/commands/orchestrate-list.js";
import { guardedStateDatabase } from "./state-db-guard.js";
import { createDispatch } from "../../src/adapters/state-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

describe("chat name display", () => {
  test("shows chat name in the dispatch list column and JSON record", () => {
    const record = { dispatchId: "dispatch-1", chatName: "fix-chat-names", state: "running", owner: "mine", ownedByCaller: true, orphan: false, uncertain: false, reconcileResult: null, raw: { chatName: "fix-chat-names" } };
    expect(formatDispatchList([record], false)).toContain("fix-chat-names");
    expect(formatDispatchList([record], true)).toContain('"chatName": "fix-chat-names"');
  });

  test("shows chat name in db show", async () => {
    const stateDirectory = mkdtempSync(resolve(tmpdir(), "megabrain-chat-name-show-"));
    try {
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: stateDirectory });
      if (database.kind !== "ok") throw new Error(database.error);
      const created = createDispatch(database.value, { dispatchId: "dispatch-show", state: "running", chatName: "fix-chat-names" });
      if (created.kind !== "ok") throw new Error(created.error);
      database.value.db.run("UPDATE dispatches SET extra = json_set(extra, '$.$present', json_array('dispatchId', 'state')) WHERE id = ?", ["dispatch-show"]);
      database.value.close();
      const shown = await executeDatabase(["show", "dispatch-show", "--json"], { MEGABRAIN_STATE_DIR: stateDirectory });
      expect(shown.kind).toBe("ok");
      if (shown.kind === "ok") expect(shown.value).toContain('"chatName": "fix-chat-names"');
    } finally { rmSync(stateDirectory, { recursive: true, force: true }); }
  });

  test("prints the stored chat name in orchestrate list for older metadata", async () => {
    const stateDirectory = mkdtempSync(resolve(tmpdir(), "megabrain-chat-name-list-"));
    try {
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: stateDirectory });
      if (database.kind !== "ok") throw new Error(database.error);
      const created = createDispatch(database.value, { dispatchId: "dispatch-list", state: "running", branch: "feat/chat-name-list", chatName: "feat/chat-name-list" });
      if (created.kind !== "ok") throw new Error(created.error);
      database.value.db.run("UPDATE dispatches SET extra = json_set(extra, '$.$present', json_array('dispatchId', 'state', 'branch')) WHERE id = ?", ["dispatch-list"]);

      const listed = await executeOrchestrateList(["--all"], { MEGABRAIN_STATE_DIR: stateDirectory, MEGABRAIN_SESSION_ID: "caller" }, {
        run: async () => ({ kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }),
        startDetached: async () => ({ kind: "failed", error: "not used" }),
        invocationCount: () => 0,
      });
      if (listed.kind !== "ok") throw new Error(listed.error);
      expect(listed.value).toContain("feat/chat-name-list");
    } finally { rmSync(stateDirectory, { recursive: true, force: true }); }
  });
});
