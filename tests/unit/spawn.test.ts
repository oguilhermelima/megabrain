import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { defaultResolveWorktree, executeSpawn, type SpawnDependencies, type SpawnWorktree } from "../../src/cli/commands/orchestrate-spawn.js";
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

function creationOptions(worktreePath: string, overrides: Record<string, unknown> = {}): Parameters<typeof defaultResolveWorktree>[1] {
  return {
    worktree: worktreePath,
    repo: "/repo",
    branch: "feat/spawn",
    agent: "codex",
    model: null,
    effort: null,
    prompt: "spawn",
    label: null,
    tmux: true,
    browser: false,
    agentArgs: [],
    json: true,
    ...overrides,
  } as Parameters<typeof defaultResolveWorktree>[1];
}

async function creationFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-create-`);
  const repo = `${root}/repo`;
  const sharedPath = `${root}/shared`;
  const state = `${root}/state`;
  const target = `${root}/missing`;
  await mkdir(repo, { recursive: true });
  await mkdir(sharedPath, { recursive: true });
  const shared = await realpath(sharedPath);
  await mkdir(state, { recursive: true });
  await writeFile(`${state}/worktree-root`, `${shared}\n`);
  const process = processFor([], (command, args) => {
    if (command !== "git") return ok({ stdout: "", stderr: "", exitCode: 0 });
    if (args.includes("worktree") && args.includes("list")) return failed("not available", 1);
    if (args.includes("--show-toplevel")) return ok({ stdout: `${repo}\n`, stderr: "", exitCode: 0 });
    if (args.includes("--path-format=absolute")) return failed("not a linked worktree", 1);
    if (args.includes("--verify")) return ok({ stdout: "commit\n", stderr: "", exitCode: 0 });
    if (args.includes("show-ref")) return failed("branch does not exist", 1);
    if (args.includes("worktree") && args.includes("add")) return ok({ stdout: "", stderr: "", exitCode: 0 });
    if (args.includes("refs/remotes/origin/HEAD")) return failed("origin/HEAD is unset", 1);
    if (args.includes("get-url")) return failed("origin is unset", 1);
    if (args.includes("init.defaultBranch")) return ok({ stdout: "main\n", stderr: "", exitCode: 0 });
    return ok({ stdout: "", stderr: "", exitCode: 0 });
  });
  const result = await defaultResolveWorktree(target, creationOptions(target, { ...overrides, repo }), { MEGABRAIN_STATE_DIR: state }, process);
  return { root, repo, shared, state, target, calls: process.calls, result };
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

  test("creates the host terminal without a command", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-host-create-`);
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "launch", "--tmux", "false"], {
        ...environment(root, "dispatch-host-create"),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing")));
      expect(process.calls[0]).toEqual({ command: "orca", args: ["terminal", "create", "--worktree", "path:/work/tree", "--title", "codex /work/tree", "--json"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns readiness-timeout after submitting the command and does not send the prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-readiness-timeout-`);
    const dispatchId = "dispatch-readiness-timeout";
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : command === "orca" && args[1] === "wait"
        ? failed("terminal remained busy")
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "timeout", "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "1234",
      }, process, options(worktree("existing")));
      expect(result).toEqual({ kind: "failed", error: "readiness-timeout: orca terminal child-terminal did not become ready within 1234ms", exitCode: 1 });
      const hostCalls = process.calls.filter((call) => call.command === "orca" && (call.args[1] === "send" || call.args[1] === "wait"));
      expect(hostCalls.map((call) => call.args[1])).toEqual(["send", "wait"]);
      expect(hostCalls.filter((call) => call.args[1] === "send")).toHaveLength(1);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta.reason).toBe("readiness-timeout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("submits the host command, waits for readiness, and then sends the prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-readiness-order-`);
    const dispatchId = "dispatch-readiness-order";
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "order", "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing")));
      const hostCalls = process.calls.filter((call) => call.command === "orca" && (call.args[1] === "wait" || call.args[1] === "send"));
      const sequence = hostCalls.map((call) => {
        if (call.args[1] === "wait") return "readiness";
        const text = call.args[call.args.indexOf("--text") + 1] ?? "";
        return text.includes("MEGABRAIN_DISPATCH_ID") ? "command" : "prompt";
      });
      expect(sequence).toEqual(["command", "readiness", "prompt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns command-not-submitted and does not wait when host command submission fails", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-command-failure-`);
    const dispatchId = "dispatch-command-failure";
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : command === "orca" && args[1] === "send" && (args[args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID")
        ? failed("command rejected")
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "submission", "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result).toEqual({ kind: "failed", error: "command-not-submitted", exitCode: 1 });
      expect(process.calls.some((call) => call.command === "orca" && call.args[1] === "wait")).toBe(false);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta.reason).toBe("command-not-submitted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("forwards --base literally to worktree creation", async () => {
    const fixture = await creationFixture({ base: "release/next" });
    try {
      expect(fixture.result.kind).toBe("ok");
      expect(fixture.calls).toContainEqual({ command: "git", args: ["-C", fixture.repo, "rev-parse", "--verify", "release/next^{commit}"] });
      expect(fixture.calls).toContainEqual({ command: "git", args: ["-C", fixture.repo, "worktree", "add", `${fixture.shared}/feat-spawn`, "-b", "feat/spawn", "release/next"] });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("forwards --name literally to worktree creation", async () => {
    const fixture = await creationFixture({ name: "operator-name" });
    try {
      expect(fixture.result.kind).toBe("ok");
      expect(fixture.calls).toContainEqual({ command: "git", args: ["-C", fixture.repo, "worktree", "add", `${fixture.shared}/operator-name`, "-b", "feat/spawn", "main"] });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("forwards --base and --name together to worktree creation", async () => {
    const fixture = await creationFixture({ base: "release/next", name: "operator-name" });
    try {
      expect(fixture.result.kind).toBe("ok");
      expect(fixture.calls).toContainEqual({ command: "git", args: ["-C", fixture.repo, "rev-parse", "--verify", "release/next^{commit}"] });
      expect(fixture.calls).toContainEqual({ command: "git", args: ["-C", fixture.repo, "worktree", "add", `${fixture.shared}/operator-name`, "-b", "feat/spawn", "release/next"] });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses creation flags for an existing worktree instead of ignoring them", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-existing-`);
    const process = processFor([], (command, args) => args.includes("--show-toplevel")
      ? ok({ stdout: `${root}\n`, stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await defaultResolveWorktree(root, creationOptions(root, { base: "release/next", name: "operator-name" }), {}, process);
      expect(result).toEqual({ kind: "failed", error: "worktree already exists; --base and --name cannot be applied", exitCode: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    "--chain",
    "--from",
    "--parent",
    "--no-parent",
    "--issue",
    "--linear-issue",
    "--pr",
    "--orchestrate",
  ])("refuses unsupported %s by name", async (flag) => {
    const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "spawn", flag, "value"], {}, processFor([]));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain(flag);
  });
});
