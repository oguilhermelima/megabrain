import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeSpawn, type SpawnDependencies, type SpawnWorktree } from "../../src/cli/commands/orchestrate-spawn.js";
import { getTmux, registerTmux, type TmuxProvider } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

const worktree = (ownership: SpawnWorktree["ownership"]): SpawnWorktree => ({
  path: "/work/tree",
  branch: "feat/example",
  ownership,
  workspaceId: "workspace-1",
});

function processFor(events: string[], behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> = (command, args) => command === "tmux" && args[0] === "list-panes"
  ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
  : ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      events.push(`${command} ${args.join(" ")}`);
      return behavior(command, args);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

function environment(root: string, dispatchId: string): Record<string, string> {
  return {
    MEGABRAIN_STATE_DIR: root,
    MEGABRAIN_SESSION_ID: "parent-terminal",
    MEGABRAIN_SESSION_HOST: "tmux",
    MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId,
    MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
  };
}

function options(resolved: SpawnWorktree): SpawnDependencies {
  return { resolveWorktree: async () => ok(resolved) };
}

describe("executeSpawn", () => {
  test("writes metadata, creates tmux, sends command and prompt, and confirms delivery", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-`);
    const events: string[] = [];
    const dispatchId = "dispatch-success";
    const process = processFor(events, (command, args) => command === "tmux" && args[0] === "list-panes"
      ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    const original = getTmux();
    const fake: TmuxProvider = {
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => {
        events.push(`text:${text.startsWith("[megabrain dispatch") ? "prompt" : "command"}`);
        if (text.startsWith("[megabrain dispatch")) {
          const directory = `${root}/dispatches/${dispatchId}`;
          await mkdir(`${directory}/messages`, { recursive: true });
          await writeFile(`${directory}/messages/9999-child-received.json`, JSON.stringify({ type: "received", from: "child" }));
        }
        return ok(undefined);
      },
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(result.error);
      expect(result.exitCode).toBe(0);
      expect(events.filter((event) => event.startsWith("text:") || event.startsWith("key:")).slice(-4)).toEqual(["text:command", "key:Tab", "text:prompt", "key:Tab"]);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ dispatchId, state: "running", promptDelivery: "delivered", promptState: "confirmed", runtime: "tmux", tmuxSession: `megabrain-${dispatchId}`, tmuxPane: "%9" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns success while receipt is pending and points to reconcile", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-`);
    const process = processFor([]);
    const dispatchId = "dispatch-awaiting";
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined) });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "wait", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(result.error);
      expect(result.exitCode).toBe(0);
      expect(result.value).toContain(`megabrain orchestrate reconcile ${dispatchId}`);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ state: "spawning", promptTransport: "transported", promptState: "awaiting-receipt", promptReceipt: "pending" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["created", true, "tmux"],
    ["existing", false, "tmux"],
  ] as const)("cleans up a %s worktree only when launch owns it", async (ownership, removeExpected) => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-`);
    const removed: string[] = [];
    const events: string[] = [];
    const process = processFor(events);
    const dispatchId = `dispatch-${ownership}`;
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => failed("launch failed"), sendKey: async () => ok(undefined) });
    const dependencies: SpawnDependencies = { ...options(worktree(ownership)), removeWorktree: async (path) => { removed.push(path); return ok(undefined); } };
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "fail", "--tmux", "true"], environment(root, dispatchId), process, dependencies);
      expect(result.kind).toBe("failed");
      expect(removed).toEqual(removeExpected ? ["/work/tree"] : []);
      expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "kill-session")).toBe(true);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses host cleanup instead of tmux cleanup", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-`);
    const events: string[] = [];
    const process = processFor(events, (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : command === "orca" && args[1] === "send"
        ? failed("launch failed")
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "fail", "--tmux", "false"], { ...environment(root, "dispatch-host"), MEGABRAIN_SESSION_HOST: "orca" }, process, options(worktree("existing")));
      expect(result.kind).toBe("failed");
      expect(process.calls.some((call) => call.command === "orca" && call.args[1] === "close")).toBe(true);
      expect(process.calls.some((call) => call.command === "tmux")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
