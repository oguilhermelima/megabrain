import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok } from "../../src/core/result.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { appendReceived, cleanupRun, dispatchMessages, existingWorktree, processFor, readMeta, runComposerSpawn, spawnEnvironment } from "./spawn-harness.js";
import { composerPane } from "./composer-tmux.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

// The variable no longer exists. Setting it proves a leftover export cannot bring a deadline back.
const staleDeadline = { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0.4" };
const killedPane = (calls: readonly { readonly command: string; readonly args: readonly string[] }[]): boolean =>
  calls.some((call) => call.command === "tmux" && (call.args[0] === "kill-pane" || call.args[0] === "kill-session"));
const afterFirstPaste = (events: readonly string[]): readonly string[] => events.slice(events.indexOf("paste"));

describe("spawn prompt receipt (tmux)", () => {
  test("has no receipt deadline to export", async () => {
    const module = await import("../../src/cli/commands/spawn-prompt.js") as Record<string, unknown>;
    expect(module.receiptTimeoutMs).toBeUndefined();
  });

  test("a prompt that never started a turn is not resent, failed or reported: the dispatch keeps waiting", async () => {
    const removed: string[] = [];
    const run = await runComposerSpawn(
      "dispatch-unreceived",
      { agent: "codex", ignoreEnters: 99 },
      staleDeadline,
      [],
      undefined,
      { resolveWorktree: async () => ok({ ...existingWorktree, ownership: "created" }), removeWorktree: async (path) => { removed.push(path); return ok(undefined); } },
    );
    try {
      expect(run.result.kind).toBe("ok");
      // One delivery: the paste proof, two Enters and the paste end marker with a last Enter. No clear, no second paste.
      expect(run.pane.pastes).toHaveLength(1);
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:Enter", "key:Enter", "end-marker", "key:Enter"]);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "spawning", terminalState: "owned", promptState: "awaiting-receipt", promptReceipt: "pending" });
      expect(readMeta(run.root, run.dispatchId).reason ?? null).toBeNull();
      expect(killedPane(run.process.calls)).toBe(false);
      expect(removed).toEqual([]);
      expect(dispatchMessages(run.root, run.dispatchId).filter((m) => m.from === "child")).toEqual([]);
    } finally {
      await cleanupRun(run);
    }
  });

  test("never resends once a turn started, records receiptMissing silently and keeps running", async () => {
    const run = await runComposerSpawn("dispatch-turn-no-receipt", { agent: "claude", afterSubmit: "working" }, staleDeadline);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(run.pane.submissions).toHaveLength(1);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "running", terminalState: "owned", processState: "running", promptReceipt: "not-received", receiptMissing: { reason: "no-receipt-after-turn" } });
      expect(readMeta(run.root, run.dispatchId).reason ?? null).toBeNull();
      // Silent: no parent notice of any kind, a started turn proves the prompt arrived.
      expect(dispatchMessages(run.root, run.dispatchId).filter((m) => m.from === "child")).toEqual([]);
      expect(killedPane(run.process.calls)).toBe(false);
    } finally {
      await cleanupRun(run);
    }
  });

  test("a receipt that is already there when the paste is submitted marks the prompt confirmed", async () => {
    const id = "dispatch-received-on-submit";
    const run = await runComposerSpawn(id, { agent: "codex", onSubmit: (_prompt, root) => appendReceived(root, id) }, staleDeadline);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(readMeta(run.root, id)).toMatchObject({ promptReceipt: "received", promptState: "confirmed" });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a stale deadline variable changes nothing: zero or a long wait behave alike", async () => {
    for (const seconds of ["0", "300"]) {
      const run = await runComposerSpawn(`dispatch-stale-${seconds}`, { agent: "codex", ignoreEnters: 99 }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: seconds });
      try {
        const started = Date.now();
        expect(run.result.kind).toBe("ok");
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(run.pane.pastes).toHaveLength(1);
        expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "spawning", promptState: "awaiting-receipt", promptReceipt: "pending" });
      } finally {
        await cleanupRun(run);
      }
    }
  });
});

describe("spawn prompt left inside an open paste", () => {
  test("sends the paste end marker and Enter once more before giving up", async () => {
    const id = "dispatch-open-paste";
    const run = await runComposerSpawn(id, { agent: "claude", leavePasteOpen: 1, onSubmit: (_prompt, root) => appendReceived(root, id) }, staleDeadline);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:Enter", "key:Enter", "end-marker", "key:Enter"]);
      expect(run.pane.submissions).toEqual(run.pane.pastes);
    } finally {
      await cleanupRun(run);
    }
  });
});

describe("spawn prompt receipt (host terminal)", () => {
  test("spawns without waiting for a receipt: no failure, no resend, terminal kept", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-host-receipt-`);
    const dispatchId = "dispatch-host-unreceived";
    const process = processFor((command, args) => {
      if (command === "orca" && args[1] === "create") return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "host prompt body", "--tmux", "false"], {
        ...spawnEnvironment(root, dispatchId, staleDeadline),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, { resolveWorktree: async () => ok(existingWorktree) });
      expect(result.kind).toBe("ok");
      const promptSends = process.calls.filter((call) => call.command === "orca" && call.args[1] === "send" && call.args.some((arg) => arg.includes("host prompt body")));
      expect(promptSends).toHaveLength(1);
      expect(process.calls.some((call) => call.command === "orca" && call.args[1] === "close")).toBe(false);
      expect(readMeta(root, dispatchId)).toMatchObject({ state: "spawning", promptState: "awaiting-receipt", promptReceipt: "pending", terminalState: "owned" });
      expect(dispatchMessages(root, dispatchId).filter((m) => m.from === "child")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("spawn --json", () => {
  const parse = (stdout: string | undefined): Record<string, unknown> => {
    expect(stdout).toBeDefined();
    expect(stdout?.endsWith("\n")).toBe(true);
    return JSON.parse(stdout ?? "") as Record<string, unknown>;
  };

  test("a spawn that fails after its dispatch exists prints one JSON object with the dispatch id, status and reason", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-json-failure-`);
    const original = getTmux();
    const pane = composerPane({ agent: "codex" });
    registerTmux({ ...original, id: "tmux", paneExists: async () => ok(true), sessionExists: async () => ok(true), panesForSession: async () => ok(["%9"]), ...pane.provider, capturePane: async () => ok("Update available! Press enter to continue") } as typeof original);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "p", "--tmux", "true", "--json"], {
        ...spawnEnvironment(root, "dispatch-json-failure"),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "300",
      }, processFor(), { resolveWorktree: async () => ok(existingWorktree) });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("expected a failure");
      expect(parse(result.stdout)).toMatchObject({ status: "failed", reason: "readiness-output-invalid", dispatchId: "dispatch-json-failure", tmuxPane: "%9" });
      expect(result.error).toContain("readiness-output-invalid");
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failure before any dispatch exists still prints JSON, without a dispatch id", async () => {
    const result = await executeSpawn(["--agent", "codex", "--prompt", "p", "--json"], {}, processFor());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected a failure");
    const body = parse(result.stdout);
    expect(body).toMatchObject({ status: "failed" });
    expect(String(body.error)).toContain("--worktree");
    expect(body).not.toHaveProperty("dispatchId");
    expect(result.exitCode).toBe(2);
  });

  test("a prompt that was never received still spawns as JSON, awaiting its receipt", async () => {
    const run = await runComposerSpawn("dispatch-json-unreceived", { agent: "codex", ignoreEnters: 99 }, staleDeadline, ["--json"]);
    try {
      expect(run.result.kind).toBe("ok");
      if (run.result.kind !== "ok") throw new Error("expected success");
      expect(parse(run.result.value)).toMatchObject({ status: "spawned", reason: null, dispatchId: run.dispatchId, promptState: "awaiting-receipt" });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a turn without a receipt succeeds as JSON with receiptMissing attached", async () => {
    const run = await runComposerSpawn("dispatch-json-warning", { agent: "claude", afterSubmit: "working" }, staleDeadline, ["--json"]);
    try {
      expect(run.result.kind).toBe("ok");
      if (run.result.kind !== "ok") throw new Error("expected success");
      expect(parse(run.result.value)).toMatchObject({ status: "spawned", reason: null, dispatchId: run.dispatchId, state: "running", receiptMissing: "no-receipt-after-turn" });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a spawn that succeeds reports status and a null reason beside the dispatch id", async () => {
    const id = "dispatch-json-success";
    const run = await runComposerSpawn(id, { agent: "codex", onSubmit: (_prompt, root) => appendReceived(root, id) }, staleDeadline, ["--json"]);
    try {
      expect(run.result.kind).toBe("ok");
      if (run.result.kind !== "ok") throw new Error("expected success");
      expect(parse(run.result.value)).toMatchObject({ status: "spawned", reason: null, dispatchId: id });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a spawn without --json keeps its plain failure and prints nothing on stdout", async () => {
    const result = await executeSpawn(["--agent", "codex", "--prompt", "p"], {}, processFor());
    expect(result).toEqual({ kind: "failed", error: "either --worktree <path> or --repo <name|path> with --branch <branch> is required", exitCode: 2 });
  });
});

describe("spawn readiness", () => {
  test("records the frame readiness rejected in the dispatch's messages", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-readiness-frame-`);
    const original = getTmux();
    const pane = composerPane({ agent: "claude" });
    registerTmux({ ...original, id: "tmux", paneExists: async () => ok(true), sessionExists: async () => ok(true), panesForSession: async () => ok(["%9"]), ...pane.provider, capturePane: async () => ok("Welcome back\nChecking for updates...\nPress enter to continue") } as typeof original);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "p", "--tmux", "true"], {
        ...spawnEnvironment(root, "dispatch-rejected-frame"),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "300",
      }, processFor(), { resolveWorktree: async () => ok(existingWorktree) });
      expect(result.kind).toBe("failed");
      const frames = dispatchMessages(root, "dispatch-rejected-frame").filter((message) => message.type === "readiness-frame");
      expect(frames).toHaveLength(1);
      expect(frames[0]?.from).toBe("megabrain");
      expect(frames[0]?.text).toContain("Checking for updates...");
      expect(frames[0]?.text).toContain("claude");
      // Logging the frame must not hand the child (or the coordinator) an actionable message.
      expect(dispatchMessages(root, "dispatch-rejected-frame").filter((message) => message.from === "child")).toEqual([]);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
