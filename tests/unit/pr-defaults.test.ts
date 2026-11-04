import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeSettings } from "../../src/cli/commands/settings.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const unusedProcess = {} as ProcessAdapter;

describe("pull request defaults setting", () => {
  test("defaults to ready and persists a draft preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-pr-defaults-"));
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    const environment = { HOME: root, MEGABRAIN_STATE_DIR: state };
    try {
      const initial = await executeSettings(["get", "pr-defaults"], environment, unusedProcess);
      expect(initial.kind).toBe("ok");
      if (initial.kind === "ok") expect(JSON.parse(initial.value)).toEqual({ draft: false });
      const set = await executeSettings(["set", "pr-defaults", '{"draft":true}'], environment, unusedProcess);
      expect(set.kind).toBe("ok");
      const saved = await executeSettings(["get", "pr-defaults"], environment, unusedProcess);
      expect(saved.kind).toBe("ok");
      if (saved.kind === "ok") expect(JSON.parse(saved.value)).toEqual({ draft: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects unknown fields and non-boolean draft values", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-pr-defaults-"));
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    const environment = { HOME: root, MEGABRAIN_STATE_DIR: state };
    try {
      expect((await executeSettings(["set", "pr-defaults", '{"draft":"yes"}'], environment, unusedProcess)).kind).toBe("failed");
      expect((await executeSettings(["set", "pr-defaults", '{"draft":true,"other":1}'], environment, unusedProcess)).kind).toBe("failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
