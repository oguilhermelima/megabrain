import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessOutput } from "../../src/adapters/proc.js";
import { executeDeliveryWorker, startDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";

describe("deferred delivery worker lifecycle", () => {
  test("keeps the target lease held while parent delivery is deferred", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-delivery-worker-"));
    let starts = 0;
    const process: ProcessAdapter = {
      async run(command, args) { return failed(`${command} ${args.join(" ")} was not expected`); },
      async startDetached() { starts += 1; return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 }); },
      invocationCount() { return starts; },
    };

    try {
      const meta = { targetKind: "parent-pointer", parentHost: "tmux", parentTmuxSession: "private", parentTmuxPane: "%1" };
      expect(await startDeliveryWorker(root, "d1", "ob1", meta, process)).toBe("started");
      expect(await startDeliveryWorker(root, "d1", "ob2", meta, process)).toBe("already-running");
      expect(starts).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exits without recreating state removed before the worker starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-delivery-worker-"));
    const process: ProcessAdapter = {
      async run(command, args) { return failed(`${command} ${args.join(" ")} was not expected`); },
      async startDetached() { return failed("detached process was not expected"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeDeliveryWorker(["outbox", "holder", "lease", String(Date.now() + 60_000)], {
        HOME: root,
        MEGABRAIN_STATE_DIR: root,
      }, process);

      expect(result.kind).toBe("ok");
      expect(existsSync(join(root, "megabrain.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
