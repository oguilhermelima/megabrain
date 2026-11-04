import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessOutput } from "../../src/adapters/proc.js";
import { executeDeliveryWorker, resumeVerificationAndRecover, startDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { openDatabase, withWrite } from "../../src/db/db.js";
import { createDispatch } from "../../src/adapters/state/dispatches.js";
import { appendParentReply, stateDatabase } from "../../src/adapters/state-db.js";
import { callStateOwner, startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";

const codexWorkingScreen = readFileSync(new URL("../fixtures/agent-liveness/codex-tmux-working.txt", import.meta.url), "utf8");

describe("deferred delivery worker lifecycle", () => {
  test.each([
    ["wrapper foreground", 4240, "4240", true, "› \n", "continue", "typed"],
    ["suspended agent", 4241, "4240", false, "› \n", "", "receiver-gone"],
    ["vanished pane", 4240, "", false, "› \n", "", "receiver-gone"],
    ["Codex is busy", 4240, "4240", true, codexWorkingScreen, "You have 1 megabrain message; run megabrain check", "pointer"],
    ["busy Codex queue", 4240, "4240", true, codexWorkingScreen, "", "ack-verifying"],
  ] as const)("handles Codex delivery when %s", async (_scenario, paneForeground, panePid, shouldDeliver, screenText, expectedText, expectedTransport) => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-delivery-tmux-owner-"));
    const sessionName = "megabrain-wt-codex-child";
    const sessionId = "$6";
    const calls: string[][] = [];
    let pastedText = "";
    let owner: Awaited<ReturnType<typeof startStateOwner>> | undefined;
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (command === "tmux") {
          if (args.includes("has-session")) return ok({ stdout: "", stderr: "", exitCode: 0 });
          if (args.includes("-a") && args.includes("list-panes")) return ok({ stdout: `%4|${sessionId}\n`, stderr: "", exitCode: 0 });
          if (args.includes("list-panes")) return ok({ stdout: "%4\n", stderr: "", exitCode: 0 });
          if (args.includes("display-message") && args.at(-1) === "#{pane_pid}") return ok({ stdout: panePid === "" ? "\n" : `${panePid}\n`, stderr: "", exitCode: 0 });
          if (args.includes("display-message") && args.at(-1) === "#{session_name}") return ok({ stdout: `${sessionName}\n`, stderr: "", exitCode: 0 });
          if (args.includes("capture-pane")) return ok({ stdout: screenText, stderr: "", exitCode: 0 });
          if (args.includes("load-buffer")) pastedText = readFileSync(args.at(-1) ?? "", "utf8");
          return ok({ stdout: "", stderr: "", exitCode: 0 });
        }
        if (command === "ps" && args[0] === "-p") return ok({ stdout: "ttys004\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-ax") return ok({ stdout: "4242 /usr/local/bin/codex --thread-id child-thread\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "eww") return ok({ stdout: "4240 1 bash -c MEGABRAIN_DISPATCH_ID=tmux-owner\n4242 4240 codex --resume child\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok({ stdout: `4240 1 4240 ${paneForeground} bash -c wrapper\n4242 4240 4240 4240 codex --resume child\n`, stderr: "", exitCode: 0 });
        if (command === "lsof") return ok({ stdout: "n/rollouts/rollout-child-thread.jsonl\n", stderr: "", exitCode: 0 });
        if (command === "codex" && args[0] === "queue") return ok({ stdout: "queued\n", stderr: "", exitCode: 0 });
        return failed(`${command} ${args.join(" ")} was not expected`);
      },
      async startDetached() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
      invocationCount() { return calls.length; },
    };

    try {
      const seeded = stateDatabase({ MEGABRAIN_STATE_DIR: root });
      expect(seeded.kind).toBe("ok");
      if (seeded.kind !== "ok") throw new Error(seeded.error);
      expect(createDispatch(seeded.value, {
        dispatchId: "tmux-owner", state: "running", runtime: "tmux", childHost: "tmux",
        tmuxSession: sessionName, tmuxSessionId: sessionId, tmuxPane: "%4", terminalId: `tmux:${sessionName}:%4`,
        agent: "codex", agentPid: 4242,
        ...(_scenario === "busy Codex queue" ? { agentThreadId: "child-thread" } : {}),
      }).kind).toBe("ok");
      const reply = appendParentReply(seeded.value, "tmux-owner", { from: "parent", type: "reply", text: "continue", sessionId: "parent" }, {
        supersede: false,
        outbox: { id: "outbox-tmux-owner", targetKind: "child-delivery", target: `tmux:${sessionId}:%4`, payload: {
          dispatchId: "tmux-owner", sequence: 1, fullMessage: "continue",
          meta: { runtime: "tmux", childHost: "tmux", tmuxSession: sessionName, tmuxSessionId: sessionId, tmuxPane: "%4", terminalId: `tmux:${sessionName}:%4`, agent: "codex", agentPid: 4242, ...(_scenario === "busy Codex queue" ? { agentThreadId: "child-thread" } : {}) },
        } },
      });
      expect(reply.kind).toBe("ok");
      seeded.value.close();
      owner = await startStateOwner(root);

      const result = await executeDeliveryWorker(["outbox-tmux-owner", "holder", "lease", String(Date.now() + 3_000)], { HOME: root, MEGABRAIN_STATE_DIR: root }, process, owner.handle);
      const expectedResult = shouldDeliver ? `delivery ${expectedTransport}\n` : "delivery receiver-gone\n";
      expect(result).toMatchObject({ kind: "ok", value: expectedResult });
      if (shouldDeliver) expect(pastedText).toContain(expectedText);
      else expect(pastedText).toBe("");
      if (shouldDeliver && expectedTransport === "typed") {
        expect(calls).toContainEqual(["tmux", "paste-buffer", "-p", "-d", "-b", expect.any(String), "-t", "%4"]);
        expect(calls).toContainEqual(["tmux", "send-keys", "-t", "%4", "Enter"]);
      }
      const observed = openDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
      expect(observed.kind).toBe("ok");
      if (observed.kind === "ok") {
        expect(observed.value.db.query<{ status: string }>("SELECT status FROM outbox WHERE id = ?").get("outbox-tmux-owner")).toMatchObject({ status: shouldDeliver ? "sent" : "failed" });
        expect(observed.value.db.query<{ status: string }>("SELECT status FROM deliveries WHERE dispatch_id = ?").get("tmux-owner")).toMatchObject({ status: "outstanding" });
        const extra = observed.value.db.query<{ extra: string }>("SELECT extra FROM deliveries WHERE dispatch_id = ?").get("tmux-owner")?.extra ?? "";
        expect(extra).toContain(shouldDeliver ? `"transport":"${expectedTransport}"` : '"transport":"receiver-gone"');
        if (_scenario === "busy Codex queue") expect(extra).toContain('"transportChannel":"codex-queue"');
        observed.value.close();
      }

      expect(calls).toContainEqual(["tmux", "display-message", "-p", "-t", "%4", "#{pane_pid}"]);
      if (shouldDeliver && _scenario !== "busy Codex queue") expect(calls).not.toContainEqual(["ps", "-ww", "-p", "4242", "-o", "pid=,pgid=,tpgid=,args="]);
    } finally {
      if (owner !== undefined) await stopStateOwner(owner);
      rmSync(root, { recursive: true, force: true });
    }
  });

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
