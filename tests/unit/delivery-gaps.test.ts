import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendMessage, createDelivery, createDispatch, listDeliveries, listOutbox, stateDatabase } from "../../src/adapters/state-db.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { sweepGrokLeaders } from "../../src/agents/grok-leader.js";
import { deliveryComposer, deliveryHasKeystrokeDialog } from "../../src/cli/commands/delivery-screen.js";
import { executeDeliveryWorker } from "../../src/cli/commands/delivery-worker.js";
import { executeOrchestrateClose } from "../../src/cli/commands/orchestrate-close.js";
import { superviseOnce } from "../../src/cli/commands/supervise.js";
import { composerReadback } from "../../src/core/composer-proof.js";
import { failed, ok } from "../../src/core/result.js";

const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/mbgap-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("Claude's held peer message dialog", () => {
  // Captured from Claude 2.1.296 in bypass after an unattested peer message: a Deny/Deliver select
  // whose "❯ Deny" row is not a draft. Typing into it would answer it.
  test("is a keystroke dialog, so a typed notice waits instead of answering it", async () => {
    expect(deliveryHasKeystrokeDialog("claude", await fixture("tmux-capture-claude-held-peer.txt"))).toBe(true);
  });
});

describe("Grok's boxed composer", () => {
  test("an empty box reads as an empty composer, idle or working", async () => {
    for (const name of ["idle", "working", "queued", "waiting-response"]) {
      expect(deliveryComposer("grok", await fixture(`tmux-capture-grok-${name}.txt`))).toBe("");
    }
  });

  test("text in the box reads as the draft, without the box border", async () => {
    const wrapped = deliveryComposer("grok", await fixture("tmux-capture-grok-wrapped-paste.txt"));
    expect(wrapped).toStartWith("This is a smoke test.");
    expect(wrapped).not.toContain("│");
    expect(deliveryComposer("grok", await fixture("tmux-capture-grok-collapsed-paste.txt"))).toBe("[Pasted: 7 lines]");
  });

  test("the composer read-back drops the right border too", async () => {
    expect(composerReadback("grok", await fixture("tmux-capture-grok-collapsed-paste.txt")).region).toBe("[Pasted: 7 lines]");
    expect(composerReadback("grok", await fixture("tmux-capture-grok-wrapped-paste.txt")).region).not.toContain("│");
  });

  test("a permission dialog still holds delivery", async () => {
    expect(deliveryHasKeystrokeDialog("grok", await fixture("tmux-capture-grok-permission.txt"))).toBe(true);
    expect(deliveryHasKeystrokeDialog("grok", await fixture("tmux-capture-grok-idle.txt"))).toBe(false);
  });

  test("a reply to a Grok child without a leader is typed into its idle composer", async () => {
    const root = await tempRoot();
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    const meta = { agent: "grok", agentPid: 1, grokSessionId: "s", runtime: "host", childHost: "orca", workspaceId: "workspace", terminalId: "child-terminal", parentAgent: "claude", parentHost: "orca", parentTerminalId: "parent-terminal" };
    createDispatch(db.value, { dispatchId: "d-typed", state: "running", ...meta });
    appendMessage(db.value, "d-typed", { from: "parent", type: "reply", text: "x" }, {
      outbox: { id: "ob-typed", targetKind: "child-delivery", target: "orca:child-terminal", payload: { dispatchId: "d-typed", sequence: 1, meta, targetKind: "child-delivery", fullMessage: "↩ reply: x" } },
    });
    createDelivery(db.value, { id: "dl-typed", dispatchId: "d-typed", messageSeqs: [1], status: "outstanding" });
    const tail = (await fixture("tmux-capture-grok-idle.txt")).split("\n");
    const screen = { id: "x", ok: true, result: { terminal: { handle: "child-terminal", status: "running", tail } } };
    const sends: string[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "orca" && args[1] === "list") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "child-terminal" }] }), stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "read") return ok<ProcessOutput>({ stdout: JSON.stringify(screen), stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "send") { sends.push(args.join(" ")); return ok<ProcessOutput>({ stdout: "{}", stderr: "", exitCode: 0 }); }
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
    await executeDeliveryWorker(["ob-typed", "holder", "delivery-target:orca:child-terminal", String(Date.now() + 4000)], { HOME: root, MEGABRAIN_STATE_DIR: root }, process);
    const deliveries = listDeliveries(db.value, "d-typed");
    const outbox = listOutbox(db.value);
    expect(sends).toHaveLength(1);
    expect(deliveries.kind === "ok" ? deliveries.value[0]?.transport : undefined).toBe("typed");
    expect(outbox.kind === "ok" ? outbox.value[0]?.status : undefined).toBe("sent");
  });
});

function processFor(leaders: ReadonlySet<string>, calls: string[]): ProcessAdapter {
  return {
    async run(name, args) {
      calls.push(`${name} ${args.join(" ")}`);
      if (name === "ps") {
        const pid = args.at(-1) ?? "";
        return ok<ProcessOutput>({ stdout: leaders.has(pid) ? "/Users/someone/.grok/bin/grok agent leader --no-exit-on-disconnect\n" : "", stderr: "", exitCode: leaders.has(pid) ? 0 : 1 });
      }
      return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

async function leaderFiles(root: string, name: string, pid: string): Promise<string> {
  await mkdir(join(root, "grok"), { recursive: true });
  await writeFile(join(root, "grok", `${name}.lock`), pid);
  await writeFile(join(root, "grok", `${name}.sock`), "");
  return join(root, "grok", `${name}.sock`);
}

describe("orphaned Grok leaders", () => {
  test("a leader no open dispatch owns is stopped and its files removed; an owned one is kept", async () => {
    const root = await tempRoot();
    const owned = await leaderFiles(root, "owned", "1001");
    const orphan = await leaderFiles(root, "orphan", "1002");
    const calls: string[] = [];
    await sweepGrokLeaders(root, new Set([owned]), processFor(new Set(["1001", "1002"]), calls));
    expect(calls).toContain("kill 1002");
    expect(calls).not.toContain("kill 1001");
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphan.replace(/\.sock$/, ".lock"))).toBe(false);
    expect(existsSync(owned)).toBe(true);
  });

  test("a stale lock whose process is gone is cleared without killing anything", async () => {
    const root = await tempRoot();
    const stale = await leaderFiles(root, "stale", "1003");
    const calls: string[] = [];
    await sweepGrokLeaders(root, new Set(), processFor(new Set(), calls));
    expect(calls.some((call) => call.startsWith("kill"))).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  test("each supervisor pass stops leaders whose dispatch is gone, before anything else", async () => {
    const root = await tempRoot();
    const orphan = await leaderFiles(root, "orphan", "1002");
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    const calls: string[] = [];
    await superviseOnce(root, db.value, { MEGABRAIN_STATE_DIR: root }, processFor(new Set(["1002"]), calls));
    expect(calls).toContain("kill 1002");
    expect(existsSync(orphan)).toBe(false);
  });

  test("closing any dispatch also stops leaders left behind by dispatches that were never closed", async () => {
    const root = await tempRoot();
    const orphan = await leaderFiles(root, "orphan", "1002");
    const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
    if (db.kind !== "ok") throw new Error(db.error);
    createDispatch(db.value, { dispatchId: "d-close", state: "done", runtime: "host", childHost: "orca", terminalId: "t", workspaceId: "w", terminalState: "owned", parentHost: "orca", parentSessionId: "coord" });
    const calls: string[] = [];
    const result = await executeOrchestrateClose(["d-close"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord" }, processFor(new Set(["1002"]), calls));
    expect(result.kind).toBe("ok");
    expect(calls).toContain("kill 1002");
    expect(existsSync(orphan)).toBe(false);
  });
});
