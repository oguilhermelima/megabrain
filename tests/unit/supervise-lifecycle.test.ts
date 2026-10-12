import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { executeSupervisorWorker } from "../../src/cli/commands/supervise.js";
import { createDispatch } from "../../src/adapters/state-db.js";
import { failed } from "../../src/core/result.js";
import { openDatabase } from "../../src/db/db.js";
import { listLeases } from "../../src/adapters/state-db.js";
import { acquireSupervisorLease, hasOpenDispatches, mayAutoRecover, shouldNotifyFinding } from "../../src/core/supervise.js";

describe("supervisor lifecycle decisions", () => {
  test("notifies once, again after thirty minutes, or immediately when the cause changes", () => {
    const finding = { cause: "usage-limit" as const, resetAt: "1:43 PM" };
    expect(shouldNotifyFinding(undefined, finding, 1_000)).toBe(true);
    expect(shouldNotifyFinding({ cause: "usage-limit", notifiedAt: 1_000 }, finding, 1_000 + 29 * 60_000)).toBe(false);
    expect(shouldNotifyFinding({ cause: "usage-limit", notifiedAt: 1_000 }, finding, 1_000 + 30 * 60_000)).toBe(true);
    expect(shouldNotifyFinding({ cause: "dialog-waiting", notifiedAt: 1_000 }, finding, 1_001)).toBe(true);
    expect(shouldNotifyFinding(undefined, { cause: "unknown" }, 1_000)).toBe(false);
  });

  test("auto-recovers only an unsubmitted prompt and exits when no dispatch is open", () => {
    expect(mayAutoRecover({ cause: "prompt-unsubmitted" })).toBe(true);
    for (const cause of ["usage-limit", "rate-limited", "server-error", "network", "auth-required", "dialog-waiting", "process-exited", "pane-gone", "unknown"] as const) {
      expect(mayAutoRecover({ cause })).toBe(false);
    }
    expect(hasOpenDispatches(["spawning", "running", "waiting_for_reply", "orphaned"])).toBe(true);
    expect(hasOpenDispatches(["done", "failed", "closed", "circuit_broken"])).toBe(false);
  });

  test("uses one database lease for the state directory and releases it for the next owner", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-lease-`);
    const opened = openDatabase({ MEGABRAIN_STATE_DIR: directory, HOME: directory });
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(acquireSupervisorLease(opened.value, "first", 30)).toEqual({ kind: "ok", value: true });
      expect(acquireSupervisorLease(opened.value, "second", 30)).toEqual({ kind: "ok", value: false });
      opened.value.db.run("DELETE FROM leases WHERE key = ?", ["supervise"]);
      expect(acquireSupervisorLease(opened.value, "second", 30)).toEqual({ kind: "ok", value: true });
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("supervisor worker", () => {
  test("exits when its state directory is deleted underneath it", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-gone-`);
    const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SUPERVISE_INTERVAL_SECONDS: "1" };
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const created = createDispatch(opened.value, { dispatchId: "d1", state: "running" });
    if (created.kind !== "ok") throw new Error(created.error);
    opened.value.close();
    const process = { async run() { return failed("not used"); }, async startDetached() { return failed("not used"); }, invocationCount() { return 0; } };
    const worker = executeSupervisorWorker(["1-00000000-0000-0000-0000-000000000000"], environment, process);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await rm(directory, { recursive: true, force: true });
    const outcome = await Promise.race([worker.then(() => "exited"), new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 4000))]);
    expect(outcome).toBe("exited");
  }, 10000);

  test("records its own process id as the lease holder so --stop reaches it", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-pid-`);
    const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SUPERVISE_INTERVAL_SECONDS: "1" };
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const created = createDispatch(opened.value, { dispatchId: "d1", state: "running" });
    if (created.kind !== "ok") throw new Error(created.error);
    const starter = "1-00000000-0000-0000-0000-000000000000";
    expect(acquireSupervisorLease(opened.value, starter, 30)).toEqual({ kind: "ok", value: true });
    const process = { async run() { return failed("not used"); }, async startDetached() { return failed("not used"); }, invocationCount() { return 0; } };
    const worker = executeSupervisorWorker([starter], environment, process);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const leases = listLeases(opened.value);
      if (leases.kind !== "ok") throw new Error(leases.error);
      const holder = leases.value.find((lease) => lease.key === "supervise")?.holder ?? "";
      expect(holder.split("-", 1)[0]).toBe(String(globalThis.process.pid));
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
      await worker;
    }
  }, 10000);
});
