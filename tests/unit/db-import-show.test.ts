import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { route } from "../../src/cli/router.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const processAdapter = { run: async () => ({ kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }) } as ProcessAdapter;

async function withDirectories<T>(operation: (root: string, state: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "megabrain-db-show-"));
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  try { return await operation(root, state); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function run(state: string, args: string[]) {
  return route(args, { environment: { MEGABRAIN_STATE_DIR: state }, processAdapter });
}

function requireOutput(result: Awaited<ReturnType<typeof run>>): string {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

async function sourceHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(current: string, relative = ""): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path, key);
      else hashes[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  await visit(directory);
  return hashes;
}

const meta = (dispatchId: string, extra: Record<string, unknown> = {}) => ({ dispatchId, state: "running", parentSessionId: "parent-1", ...extra });
const message = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, from: "child", type: "received", text: "ready", createdAt: "2026-09-01T00:00:00.000Z", ...extra });
const delivery = (id: string, dispatchId: string, extra: Record<string, unknown> = {}) => ({ id, dispatchId, messageSeqs: [1], status: "open", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...extra });

describe("db import and db show", () => {
  test("imports dispatch files, skips identical re-imports and shows legacy JSON shape", async () => {
    await withDirectories(async (root, state) => {
      const source = join(root, "source");
      const dispatchId = "dispatch-round-trip";
      const directory = join(source, "dispatches", dispatchId);
      const originalMeta = meta(dispatchId, { custom: { retained: true } });
      const originalMessage = message(1, { arbitrary: ["value", 2] });
      const originalDelivery = delivery("delivery-1", dispatchId, { recipient: "parent" });
      await writeJson(join(directory, "meta.json"), originalMeta);
      await writeJson(join(directory, "messages", "0001.json"), originalMessage);
      await writeJson(join(directory, "deliveries", "delivery-1.json"), originalDelivery);
      const before = await sourceHashes(source);

      const first = await run(state, ["db", "import", source, "--json"]);
      expect(first.kind).toBe("ok");
      if (first.kind === "ok") expect(JSON.parse(first.value).imported.dispatches).toBe(1);
      const shown = await run(state, ["db", "show", dispatchId, "--json"]);
      expect(JSON.parse(requireOutput(shown))).toEqual({ meta: originalMeta, messages: [originalMessage], deliveries: [originalDelivery], archived: false });

      const second = await run(state, ["db", "import", source, "--json"]);
      expect(second.kind).toBe("ok");
      if (second.kind === "ok") expect(JSON.parse(second.value).skippedIdentical.dispatches).toBe(1);
      expect(await sourceHashes(source)).toEqual(before);
    });
  });

  test("rejects conflicts atomically and --replace replaces a dispatch and its children as a set", async () => {
    await withDirectories(async (root, state) => {
      const first = join(root, "first");
      const second = join(root, "second");
      const id = "dispatch-conflict";
      await writeJson(join(first, "dispatches", id, "meta.json"), meta(id, { value: "old" }));
      await writeJson(join(first, "dispatches", id, "messages", "0001.json"), message(1));
      await writeJson(join(first, "dispatches", id, "deliveries", "old.json"), delivery("old-delivery", id));
      expect((await run(state, ["db", "import", first])).kind).toBe("ok");

      await writeJson(join(second, "dispatches", id, "meta.json"), meta(id, { value: "new" }));
      await writeJson(join(second, "dispatches", id, "messages", "0002.json"), message(2));
      await writeJson(join(second, "dispatches", id, "deliveries", "new.json"), delivery("new-delivery", id));
      await writeJson(join(second, "dispatches", "dispatch-must-rollback", "meta.json"), meta("dispatch-must-rollback"));
      const conflict = await run(state, ["db", "import", second]);
      expect(conflict.kind).toBe("failed");
      if (conflict.kind === "failed") expect(conflict.error).toContain(id);
      const absent = await run(state, ["db", "show", "dispatch-must-rollback", "--json"]);
      expect(absent.kind).toBe("failed");
      const stillOld = await run(state, ["db", "show", id, "--json"]);
      expect(JSON.parse(requireOutput(stillOld))).toMatchObject({ meta: { value: "old" }, messages: [{ seq: 1 }], deliveries: [{ id: "old-delivery" }] });

      const replaced = await run(state, ["db", "import", second, "--replace", "--json"]);
      expect(replaced.kind).toBe("ok");
      if (replaced.kind === "ok") expect(JSON.parse(replaced.value).replaced.dispatches).toBe(1);
      expect(JSON.parse(requireOutput(await run(state, ["db", "show", id, "--json"])))).toMatchObject({ meta: { value: "new" }, messages: [{ seq: 2 }], deliveries: [{ id: "new-delivery" }] });
    });
  });

  test("accepts a single dispatch directory and reports malformed input without importing it", async () => {
    await withDirectories(async (root, state) => {
      const dispatch = join(root, "one-dispatch");
      await writeJson(join(dispatch, "meta.json"), meta("single-dispatch"));
      await mkdir(join(dispatch, "messages"), { recursive: true });
      await writeFile(join(dispatch, "messages", "broken.json"), "{bad json\n");
      const before = await sourceHashes(dispatch);
      const result = await run(state, ["db", "import", dispatch, "--json"]);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toContain("broken.json");
      expect((await run(state, ["db", "show", "single-dispatch", "--json"])).kind).toBe("failed");
      expect(await sourceHashes(dispatch)).toEqual(before);
    });
  });

  test("shows archived status and errors for unknown dispatch ids", async () => {
    await withDirectories(async (root, state) => {
      const archived = join(root, "source", "dispatches", "archive", "2026-09", "dispatch-archived");
      const archivedMeta = meta("dispatch-archived", { state: "closed" });
      await writeJson(join(archived, "meta.json"), archivedMeta);
      expect((await run(state, ["db", "import", join(root, "source")])).kind).toBe("ok");
      expect(JSON.parse(requireOutput(await run(state, ["db", "show", "dispatch-archived", "--json"])))).toEqual({ meta: archivedMeta, messages: [], deliveries: [], archived: true });
      const missing = await run(state, ["db", "show", "missing", "--json"]);
      expect(missing.kind).toBe("failed");
      if (missing.kind === "failed") { expect(missing.exitCode).toBe(1); expect(missing.error).toContain("missing"); }
    });
  });

  test("shows terminal records and install state in their legacy JSON shapes", async () => {
    await withDirectories(async (root, state) => {
      const source = join(root, "source");
      const terminal = { terminalId: "terminal-1", host: "orca", custom: 7 };
      const installState = { "tmux-runtime": { installed: true, updatedAt: "2026-09-01" } };
      await writeJson(join(source, "terminals", "terminal-1.json"), terminal);
      await writeJson(join(source, "state.json"), installState);
      expect((await run(state, ["db", "import", source])).kind).toBe("ok");
      const shownTerminal = await run(state, ["db", "show", "--terminal", "terminal-1", "--json"]);
      const shownInstallState = await run(state, ["db", "show", "--install-state", "--json"]);
      expect(JSON.parse(requireOutput(shownTerminal))).toEqual(terminal);
      expect(JSON.parse(requireOutput(shownInstallState))).toEqual(installState);
    });
  });

  test("shows models registry and tmux session records in their legacy JSON shapes", async () => {
    await withDirectories(async (root, state) => {
      const source = join(root, "source");
      const models = { version: 1, models: [{ agent: "codex", model: "gpt-6-sol", reasoning: ["high"] }] };
      const session = { tmuxSession: "wrapper-1", stableSessionId: "stable-1", windows: ["main"] };
      await writeJson(join(source, "models.json"), models);
      await writeJson(join(source, "sessions", "wrapper-1.json"), session);
      expect((await run(state, ["db", "import", source])).kind).toBe("ok");
      expect(JSON.parse(requireOutput(await run(state, ["db", "show", "--models", "--json"])))).toEqual(models);
      expect(JSON.parse(requireOutput(await run(state, ["db", "show", "--tmux-session", "wrapper-1", "--json"])))).toEqual(session);
    });
  });
});
