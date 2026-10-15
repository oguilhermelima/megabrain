import { guardedStateDatabase } from "./state-db-guard.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { acquireLease, archiveDispatch, createDispatch } from "../../src/adapters/state-db.js";
import { failed } from "../../src/core/result.js";
import { executeSupervise } from "../../src/cli/commands/supervise.js";

const statusModule = await import("../../src/cli/commands/status.js").catch(() => undefined);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function environment(): { HOME: string; MEGABRAIN_STATE_DIR: string } {
  const root = mkdtempSync(join(tmpdir(), "megabrain-status-"));
  directories.push(root);
  return { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
}

function recordingAdapter(): { adapter: ProcessAdapter; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    adapter: {
      async run(command) { commands.push(command); return failed(`${command} unavailable`); },
      async startDetached() { return failed("not used"); },
      invocationCount() { return commands.length; },
    },
  };
}

function seed(env: { MEGABRAIN_STATE_DIR: string }): void {
  const opened = guardedStateDatabase(env);
  if (opened.kind !== "ok") throw new Error(opened.error);
  const db = opened.value;
  const create = (record: Record<string, unknown>) => {
    const created = createDispatch(db, { agent: "codex", parentHost: "tmux", parentSessionId: "another-session", ...record });
    if (created.kind !== "ok") throw new Error(created.error);
  };
  create({
    dispatchId: "d-running", state: "running", label: "lane one",
    superviseLastCheck: "2026-10-14T12:00:00.000Z",
    superviseFinding: { cause: "usage-limit", resetAt: "2026-10-15T10:00:00.000Z", lastSeenAt: "2026-10-14T12:00:00.000Z" },
  });
  create({ dispatchId: "d-queued", state: "queued", admissionReason: "memory below 2048 MiB\nmore detail" });
  create({ dispatchId: "d-done", state: "done" });
  create({ dispatchId: "d-closed", state: "closed" });
  create({ dispatchId: "d-archived", state: "failed" });
  const archived = archiveDispatch(db, "d-archived");
  if (archived.kind !== "ok") throw new Error(archived.error);
  const lease = acquireLease(db, "supervise", "4242-holder", 60);
  if (lease.kind !== "ok") throw new Error(lease.error);
}

async function statusJson(env: Record<string, string>, adapter: ProcessAdapter): Promise<Record<string, any>> {
  expect(statusModule).toBeDefined();
  const result = await statusModule!.executeStatus(["--json"], env, adapter);
  expect(result.kind).toBe("ok");
  return result.kind === "ok" ? JSON.parse(result.value) : {};
}

describe("megabrain status --json", () => {
  test("reports every section the panel reads", async () => {
    const env = environment();
    seed(env);
    const status = await statusJson(env, recordingAdapter().adapter);
    expect(Number.isNaN(Date.parse(status.generatedAt))).toBe(false);
    for (const key of ["context", "machine", "supervisor", "dispatches", "queue", "processes", "resources", "deliveryChannels"]) {
      expect(status).toHaveProperty(key);
    }
    expect(status.supervisor).toEqual({ watcher: { running: true, pid: 4242 } });
    expect(status.resources).toEqual({ history: false, admission: null });
    expect(status.processes).toEqual([]);
    expect(status.deliveryChannels).toEqual([]);
  });

  test("lists every session's dispatches that are not closed or archived", async () => {
    const env = environment();
    seed(env);
    const status = await statusJson(env, recordingAdapter().adapter);
    const ids = (status.dispatches as Record<string, any>[]).map((item) => item.dispatchId).sort();
    expect(ids).toEqual(["d-done", "d-queued", "d-running"]);
    const running = (status.dispatches as Record<string, any>[]).find((item) => item.dispatchId === "d-running");
    expect(running).toMatchObject({ state: "running", agent: "codex", label: "lane one", parentSessionId: "another-session" });
  });

  test("carries the supervisor's finding with its recommendation", async () => {
    const env = environment();
    seed(env);
    const status = await statusJson(env, recordingAdapter().adapter);
    const running = (status.dispatches as Record<string, any>[]).find((item) => item.dispatchId === "d-running");
    expect(running?.supervision).toEqual({
      lastCheck: "2026-10-14T12:00:00.000Z",
      finding: {
        cause: "usage-limit",
        resetAt: "2026-10-15T10:00:00.000Z",
        lastSeenAt: "2026-10-14T12:00:00.000Z",
        recommendation: expect.stringContaining("2026-10-15T10:00:00.000Z"),
      },
    });
    const done = (status.dispatches as Record<string, any>[]).find((item) => item.dispatchId === "d-done");
    expect(done?.supervision).toEqual({ lastCheck: null, finding: null });
  });

  test("shows queued work whoever owns it", async () => {
    const env = environment();
    seed(env);
    const status = await statusJson(env, recordingAdapter().adapter);
    expect(status.queue).toContainEqual(expect.objectContaining({ id: "d-queued", kind: "spawn", state: "queued", text: "memory below 2048 MiB" }));
  });

  test("reports a stopped watcher", async () => {
    const env = environment();
    const status = await statusJson(env, recordingAdapter().adapter);
    expect(status.supervisor).toEqual({ watcher: { running: false, pid: null } });
    expect(status.dispatches).toEqual([]);
  });

  test("never waits on docker", async () => {
    const env = environment();
    seed(env);
    const recorded = recordingAdapter();
    await statusJson(env, recorded.adapter);
    expect(recorded.commands.filter((command) => command === "docker" || command === "orb" || command === "orbctl")).toEqual([]);
  });

  test("prints a short summary without --json", async () => {
    const env = environment();
    seed(env);
    const result = await statusModule!.executeStatus([], env, recordingAdapter().adapter);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value).toContain("watcher: running (pid 4242)");
    expect(result.value).toContain("dispatches: 3 (done 1, queued 1, running 1); findings 1");
    expect(result.value).toContain("queue: 1");
  });

  test("rejects an unknown option", async () => {
    const result = await statusModule!.executeStatus(["--bogus"], environment(), recordingAdapter().adapter);
    expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
  });
});

describe("megabrain supervise --status", () => {
  test("never waits on docker", async () => {
    const env = environment();
    seed(env);
    const recorded = recordingAdapter();
    const result = await executeSupervise(["--status"], env, recorded.adapter);
    expect(result.kind).toBe("ok");
    expect(recorded.commands.filter((command) => command === "docker" || command === "orb" || command === "orbctl")).toEqual([]);
  });
});
