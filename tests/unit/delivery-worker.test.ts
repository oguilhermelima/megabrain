import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed } from "../../src/core/result.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";

describe("deferred delivery worker lifecycle", () => {
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
