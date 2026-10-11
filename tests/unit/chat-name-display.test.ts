import { describe, expect, test } from "bun:test";
import { formatDispatchList } from "../../src/core/dispatch.js";
import { executeDatabase } from "../../src/cli/commands/db.js";
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
      const shown = await executeDatabase(["show", "dispatch-show", "--json"], { MEGABRAIN_STATE_DIR: stateDirectory });
      expect(shown.kind).toBe("ok");
      if (shown.kind === "ok") expect(shown.value).toContain('"chatName": "fix-chat-names"');
    } finally { rmSync(stateDirectory, { recursive: true, force: true }); }
  });
});
