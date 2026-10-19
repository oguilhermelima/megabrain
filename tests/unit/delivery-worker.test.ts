import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessOutput } from "../../src/adapters/proc.js";
import { executeDeliveryWorker, resumeVerificationAndRecover, startDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { createDispatch } from "../../src/adapters/state/dispatches.js";
import { callStateOwner, startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";

describe("deferred delivery worker lifecycle", () => {
  test("recovers promptly and logs when verifier scheduling fails", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
    let recovered = false;
    try {
      await resumeVerificationAndRecover("outbox-1", async () => { throw new Error("owner unavailable"); }, async () => { recovered = true; });
    } finally {
      console.error = originalError;
    }
    expect(recovered).toBe(true);
    expect(errors.join(" ")).toContain("outbox-1");
    expect(errors.join(" ")).toContain("owner unavailable");
  });

  test("the owner delivers a published row without starting a detached worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-delivery-worker-"));
    let starts = 0;
    let owner: Awaited<ReturnType<typeof startStateOwner>> | undefined;
    const process: ProcessAdapter = {
      async run(command, args) { return failed(`${command} ${args.join(" ")} was not expected`); },
      async startDetached() { starts += 1; return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 }); },
      invocationCount() { return starts; },
    };

    try {
      const seeded = openDatabase({ MEGABRAIN_STATE_DIR: root });
      expect(seeded.kind).toBe("ok");
      if (seeded.kind !== "ok") throw new Error(seeded.error);
      expect(createDispatch(seeded.value, { dispatchId: "d1", state: "running", parentHost: "local" }).kind).toBe("ok");
      seeded.value.close();
      owner = await startStateOwner(root);
      const result = await callStateOwner(root, {
        operation: "append-queue-message",
        dispatchId: "d1",
        message: { from: "child", type: "done", text: "finished", sessionId: "child", createdAt: new Date().toISOString() },
        dispatch: { dispatchId: "d1", parentHost: "local", parentSessionId: "parent", agent: "codex" },
      }) as { sequence: number; outboxId: string };
      expect(result.sequence).toBe(1);
      expect(result.outboxId).toBeString();
      expect(await startDeliveryWorker(root, "d1", result.outboxId, { targetKind: "parent-pointer", parentHost: "local", parentSessionId: "parent" }, process)).toBe("already-running");
      const deadline = Date.now() + 5_000;
      let status = "pending";
      while (Date.now() < deadline && (status === "pending" || status === "sending")) {
        status = owner.handle.db.query<{ status: string }>("SELECT status FROM outbox WHERE id = ?").get(result.outboxId)?.status ?? "missing";
        if (status === "pending" || status === "sending") await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(["sent", "failed", "suppressed"]).toContain(status);
      expect(starts).toBe(0);
    } finally {
      if (owner !== undefined) await stopStateOwner(owner);
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
