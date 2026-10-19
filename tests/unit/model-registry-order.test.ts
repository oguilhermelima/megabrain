import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { insertModel, listModels } from "../../src/db/queries/aux-state.js";

let stateDir: string;
const directories: string[] = [];

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("model registry persistence", () => {
  test("preserves registry order when reading models", () => {
    stateDir = mkdtempSync(join(tmpdir(), "megabrain-model-order-"));
    directories.push(stateDir);
    const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(withWrite(opened.value, (db) => {
        insertModel(db, { agent: "codex", model: "gpt-6-luna" }, { version: 1 });
        insertModel(db, { agent: "codex", model: "gpt-6-sol" }, { version: 1 });
        insertModel(db, { agent: "claude", model: "claude-opus-5-5" }, { version: 1 });
      }).kind).toBe("ok");
      expect((listModels(opened.value.db).models as { agent: string; model: string }[]).map(({ agent, model }) => `${agent}/${model}`)).toEqual([
        "codex/gpt-6-luna", "codex/gpt-6-sol", "claude/claude-opus-5-5",
      ]);
    } finally {
      opened.value.close();
    }
  });
});
