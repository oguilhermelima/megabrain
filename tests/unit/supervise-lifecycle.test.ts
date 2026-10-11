import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/db.js";
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
