import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok } from "../../src/core/result.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { appendReceived, cleanupRun, dispatchMessages, existingWorktree, processFor, readMeta, runComposerSpawn, spawnEnvironment } from "./spawn-harness.js";
import { composerPane } from "./composer-tmux.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

const waitsForReceipt = { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0.4" };
const killedPane = (calls: readonly { readonly command: string; readonly args: readonly string[] }[]): boolean =>
  calls.some((call) => call.command === "tmux" && (call.args[0] === "kill-pane" || call.args[0] === "kill-session"));
const afterFirstPaste = (events: readonly string[]): readonly string[] => events.slice(events.indexOf("paste"));

describe("spawn prompt receipt (tmux)", () => {
  test("sends the prompt once more when no turn started and no receipt came, then fails keeping the pane", async () => {
    const removed: string[] = [];
    const run = await runComposerSpawn(
      "dispatch-unreceived",
      { agent: "codex", ignoreEnters: 99 },
      waitsForReceipt,
      [],
      undefined,
      { resolveWorktree: async () => ok({ ...existingWorktree, ownership: "created" }), removeWorktree: async (path) => { removed.push(path); return ok(undefined); } },
    );
    try {
      expect(run.result.kind).toBe("failed");
      if (run.result.kind !== "failed") throw new Error("expected a failure");
      expect(run.result.error).toContain("prompt-not-received");
      expect(run.result.error).toContain("kept for inspection");
      // One resend: the composer is cleared, the whole prompt pasted again, and Enter pressed twice each time.
      expect(run.pane.pastes).toHaveLength(2);
      expect(run.pane.pastes[1]).toBe(run.pane.pastes[0]);
      expect(afterFirstPaste(run.events)).toEqual(["paste", "key:Enter", "key:Enter", "key:C-u", "paste", "key:Enter", "key:Enter"]);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "failed", reason: "prompt-not-received", terminalState: "owned", processState: "start-unproven", promptReceipt: "not-received" });
      expect(killedPane(run.process.calls)).toBe(false);
      expect(removed).toEqual([]);
      expect(dispatchMessages(run.root, run.dispatchId).filter((m) => m.from === "child" && m.type === "stalled")).toHaveLength(1);
    } finally {
      await cleanupRun(run);
    }
  });

  test("never resends once a turn started, and fails with the reason that says so", async () => {
    const run = await runComposerSpawn("dispatch-turn-no-receipt", { agent: "claude", afterSubmit: "working" }, waitsForReceipt);
    try {
      expect(run.result.kind).toBe("failed");
      if (run.result.kind !== "failed") throw new Error("expected a failure");
      expect(run.result.error).toContain("no-receipt-after-turn");
      expect(run.result.error).toContain("kept for inspection");
      expect(run.pane.pastes).toHaveLength(1);
      expect(run.pane.submissions).toHaveLength(1);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "failed", reason: "no-receipt-after-turn", terminalState: "owned", processState: "running" });
      const stalled = dispatchMessages(run.root, run.dispatchId).filter((m) => m.from === "child" && m.type === "stalled");
      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.text).toContain("no-receipt-after-turn");
      expect(killedPane(run.process.calls)).toBe(false);
    } finally {
      await cleanupRun(run);
    }
  });

  test("succeeds when the resend is the one that reaches the child", async () => {
    const id = "dispatch-resend-received";
    const run = await runComposerSpawn(id, { agent: "codex", ignoreEnters: 2, onSubmit: (_prompt, root) => appendReceived(root, id) }, waitsForReceipt);
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(2);
      expect(run.pane.submissions).toHaveLength(1);
      expect(readMeta(run.root, id)).toMatchObject({ promptReceipt: "received", promptState: "confirmed" });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a receipt timeout of zero keeps meaning do not wait: no resend, no failure", async () => {
    const run = await runComposerSpawn("dispatch-zero-wait", { agent: "codex", ignoreEnters: 99 }, { MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" });
    try {
      expect(run.result.kind).toBe("ok");
      expect(run.pane.pastes).toHaveLength(1);
      expect(readMeta(run.root, run.dispatchId)).toMatchObject({ state: "spawning", promptState: "awaiting-receipt", promptReceipt: "pending" });
    } finally {
      await cleanupRun(run);
    }
  });
});

describe("spawn prompt left inside an open paste", () => {
  test("sends the paste end marker and Enter once more before giving up", async () => {
    const id = "dispatch-open-paste";
    const run = await runComposerSpawn(id, { agent: "claude", leavePasteOpen: 1, onSubmit: (_prompt, root) => appendReceived(root, id) }, waitsForReceipt);
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
  test("fails with no-receipt-unproven instead of waiting forever, without resending or closing the terminal", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-host-receipt-`);
    const dispatchId = "dispatch-host-unreceived";
    const process = processFor((command, args) => {
      if (command === "orca" && args[1] === "create") return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "host prompt body", "--tmux", "false"], {
        ...spawnEnvironment(root, dispatchId, waitsForReceipt),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, { resolveWorktree: async () => ok(existingWorktree) });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") throw new Error("expected a failure");
      expect(result.error).toContain("no-receipt-unproven");
      expect(result.error).toContain("kept for inspection");
      const promptSends = process.calls.filter((call) => call.command === "orca" && call.args[1] === "send" && call.args.some((arg) => arg.includes("host prompt body")));
      expect(promptSends).toHaveLength(1);
      expect(process.calls.some((call) => call.command === "orca" && call.args[1] === "close")).toBe(false);
      expect(readMeta(root, dispatchId)).toMatchObject({ state: "failed", reason: "no-receipt-unproven", terminalState: "owned" });
      expect(dispatchMessages(root, dispatchId).filter((m) => m.from === "child" && m.type === "stalled")).toHaveLength(1);
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

  test("an unreceived prompt fails as JSON naming the dispatch and the kept pane", async () => {
    const run = await runComposerSpawn("dispatch-json-unreceived", { agent: "claude", afterSubmit: "working" }, waitsForReceipt, ["--json"]);
    try {
      expect(run.result.kind).toBe("failed");
      if (run.result.kind !== "failed") throw new Error("expected a failure");
      expect(parse(run.result.stdout)).toMatchObject({ status: "failed", reason: "no-receipt-after-turn", dispatchId: run.dispatchId, tmuxPane: "%9" });
    } finally {
      await cleanupRun(run);
    }
  });

  test("a spawn that succeeds reports status and a null reason beside the dispatch id", async () => {
    const id = "dispatch-json-success";
    const run = await runComposerSpawn(id, { agent: "codex", onSubmit: (_prompt, root) => appendReceived(root, id) }, waitsForReceipt, ["--json"]);
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
