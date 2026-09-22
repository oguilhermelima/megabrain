import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { defaultResolveWorktree, executeSpawn, markRunningIfSpawning, type SpawnDependencies, type SpawnWorktree } from "../../src/cli/commands/orchestrate-spawn.js";
import { getTmux, registerTmux, type TmuxProvider } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

const worktree = (ownership: SpawnWorktree["ownership"], path = "/work/tree"): SpawnWorktree => ({
  path,
  branch: "feat/example",
  ownership,
  workspaceId: "workspace-1",
});

function processFor(events: string[], behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = (command, args) => command === "tmux" && args[0] === "list-panes"
  ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
  : ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      events.push(`${command} ${args.join(" ")}`);
      return await behavior(command, args);
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

function argsContain(args: readonly string[], value: string): boolean {
  return args.includes(value) || args.some((arg) => arg.includes(value));
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
  test("marks a spawning dispatch running after prompt delivery", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-mark-running-`);
    const dispatchId = "dispatch-mark-running";
    try {
      await mkdir(`${root}/dispatches/${dispatchId}`, { recursive: true });
      await writeFile(`${root}/dispatches/${dispatchId}/meta.json`, JSON.stringify({ dispatchId, state: "spawning" }));

      const result = await markRunningIfSpawning(root, dispatchId);

      expect(result.kind).toBe("ok");
      expect(JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8"))).toMatchObject({ state: "running" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not move a waiting-for-reply dispatch back to running", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-mark-waiting-`);
    const dispatchId = "dispatch-waiting";
    try {
      await mkdir(`${root}/dispatches/${dispatchId}`, { recursive: true });
      await writeFile(`${root}/dispatches/${dispatchId}/meta.json`, JSON.stringify({ dispatchId, state: "waiting_for_reply" }));

      const result = await markRunningIfSpawning(root, dispatchId);

      expect(result.kind).toBe("ok");
      expect(JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8"))).toMatchObject({ state: "waiting_for_reply" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checks the transition table for an unknown dispatch state", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-mark-unknown-`);
    const dispatchId = "dispatch-unknown-state";
    try {
      await mkdir(`${root}/dispatches/${dispatchId}`, { recursive: true });
      await writeFile(`${root}/dispatches/${dispatchId}/meta.json`, JSON.stringify({ dispatchId, state: "future" }));

      const result = await markRunningIfSpawning(root, dispatchId);

      expect(result.kind).toBe("unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes --base through the command to worktree creation", async () => {
    let receivedBase: string | undefined;
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-command-base-`);
    try {
      await executeSpawn(["--worktree", "/work/tree", "--repo", "/repo", "--branch", "feat/spawn", "--base", "release/next", "--agent", "codex", "--prompt", "spawn", "--tmux", "false"], environment(root, "dispatch-command-base"), processFor([]), {
        resolveWorktree: async (_target, options) => {
          receivedBase = options.base;
          return ok(worktree("existing"));
        },
      });
      expect(receivedBase).toBe("release/next");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes --name through the command to worktree creation", async () => {
    let receivedName: string | undefined;
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-command-name-`);
    try {
      await executeSpawn(["--worktree", "/work/tree", "--repo", "/repo", "--branch", "feat/spawn", "--name", "operator-name", "--agent", "codex", "--prompt", "spawn", "--tmux", "false"], environment(root, "dispatch-command-name"), processFor([]), {
        resolveWorktree: async (_target, options) => {
          receivedName = options.name;
          return ok(worktree("existing"));
        },
      });
      expect(receivedName).toBe("operator-name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exports the created host terminal identity through its provider variable", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-host-identity-`);
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "identity", "--tmux", "false"], {
        ...environment(root, "dispatch-host-identity"),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing")));
      const command = process.calls.find((call) => call.command === "orca" && call.args[1] === "send" && (call.args[call.args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID"));
      const text = command?.args[command.args.indexOf("--text") + 1] ?? "";
      expect(text).toContain("ORCA_TERMINAL_HANDLE='child-terminal'");
      expect(text).toContain("MEGABRAIN_DISPATCH_ID='dispatch-host-identity'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scopes the host command to the dispatch state and clears parent tmux markers", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-host-environment-`);
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "environment", "--tmux", "false"], {
        ...environment(root, "dispatch-host-environment"),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing")));
      const command = process.calls.find((call) => call.command === "orca" && call.args[1] === "send" && (call.args[call.args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID"));
      const text = command?.args[command.args.indexOf("--text") + 1] ?? "";
      expect(text).toContain("env -u TMUX -u TMUX_PANE");
      expect(text).toContain(`MEGABRAIN_STATE_DIR='${root}'`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses the Superset terminal identity variable for Superset children", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-superset-identity-`);
    const process = processFor([], (command, args) => {
      if (command === "superset" && args[1] === "create") return ok({ stdout: JSON.stringify({ terminalId: "child-terminal" }), stderr: "", exitCode: 0 });
      if (command === "superset" && args[1] === "read") return ok({ stdout: JSON.stringify({ text: "ready" }), stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "superset", "--tmux", "false"], {
        ...environment(root, "dispatch-superset-identity"),
        MEGABRAIN_SESSION_HOST: "superset",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing")));
      const command = process.calls.find((call) => call.command === "superset" && argsContain(call.args, "MEGABRAIN_DISPATCH_ID"));
      const text = command?.args[command.args.indexOf("--text") + 1] ?? "";
      expect(text).toContain("SUPERSET_TERMINAL_ID='child-terminal'");
      expect(text).not.toContain("ORCA_TERMINAL_HANDLE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("quotes a worktree path containing a space as one shell argument", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-path-quote-`);
    const path = "/work/tree with space";
    const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
      ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(["--worktree", path, "--agent", "codex", "--prompt", "quoted", "--tmux", "false"], {
        ...environment(root, "dispatch-path-quote"),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, options(worktree("existing", path)));
      const command = process.calls.find((call) => call.command === "orca" && argsContain(call.args, "MEGABRAIN_DISPATCH_ID"));
      const text = command?.args[command.args.indexOf("--text") + 1] ?? "";
      expect(text).toContain("cd '/work/tree with space' &&");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps tmux identity variables and adds the shared state directory", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-environment-`);
    const dispatchId = "dispatch-tmux-environment";
    const commandTexts: string[] = [];
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => { commandTexts.push(text); return ok(undefined); },
      sendKey: async () => ok(undefined),
    });
    try {
      await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "tmux", "--tmux", "true"], environment(root, dispatchId), processFor([]), options(worktree("existing")));
      const command = commandTexts.find((text) => text.includes("MEGABRAIN_DISPATCH_ID")) ?? "";
      expect(command).toContain("MEGABRAIN_DISPATCH_ID");
      expect(command).toContain("MEGABRAIN_TMUX_SESSION");
      expect(command).toContain("MEGABRAIN_TMUX_PANE");
      expect(command).toContain(`MEGABRAIN_STATE_DIR='${root}'`);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("preserves a child ask that races with prompt bookkeeping", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-racing-ask-`);
    const events: string[] = [];
    const dispatchId = "dispatch-racing-ask";
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
          const metaPath = `${directory}/meta.json`;
          await mkdir(`${directory}/messages`, { recursive: true });
          await writeFile(`${directory}/messages/9999-child-received.json`, JSON.stringify({ type: "received", from: "child" }));
          const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
          await writeFile(metaPath, JSON.stringify({ ...meta, state: "waiting_for_reply", processState: "running" }));
        }
        return ok(undefined);
      },
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ state: "waiting_for_reply", processState: "running" });
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

  test("retries a host terminal create beyond the old deadline before registration completes", async () => {
    expect.assertions(3);
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-create-retry-`);
    let createAttempts = 0;
    const process = processFor([], async (command, args) => {
      if (command === "orca" && args[1] === "create") {
        createAttempts += 1;
        if (createAttempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return failed("workspace is still registering", 1);
        }
        return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "retry", "--tmux", "false", "--json"], {
        ...environment(root, "dispatch-create-retry"),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(result.error);
      expect(JSON.parse(result.value)).toMatchObject({ terminalId: "child-terminal", terminalCreateAttempts: 2 });
      expect(createAttempts).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports attempts and elapsed time when host terminal creation reaches its deadline", async () => {
    expect.assertions(5);
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-create-failure-`);
    const prompt = "private prompt body that must not appear in the error";
    const process = processFor([], async (command, args) => {
      if (command === "orca" && args[1] === "create") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return failed("workspace registration still pending", 1);
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "false"], {
        ...environment(root, "dispatch-create-failure"),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.error).not.toContain(prompt);
        const match = result.error.match(/after (\d+) attempts in (\d+)ms$/);
        expect(match).not.toBeNull();
        if (match !== null) {
          expect(Number(match[1])).toBeLessThan(6);
          expect(Number(match[2])).toBeGreaterThanOrEqual(2000);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds an instantly failing host terminal create by the attempt cap", async () => {
    expect.assertions(4);
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-create-cap-`);
    let createAttempts = 0;
    const process = processFor([], (command, args) => {
      if (command === "orca" && args[1] === "create") {
        createAttempts += 1;
        return failed("host is unavailable", 1);
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "cap", "--tmux", "false"], {
        ...environment(root, "dispatch-create-cap"),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("failed");
      expect(createAttempts).toBe(6);
      if (result.kind === "failed") expect(result.error).toMatch(/after 6 attempts in \d+ms$/);
      expect(process.calls.filter((call) => call.command === "orca" && call.args[1] === "create")).toHaveLength(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not retry after a host terminal identity is returned", async () => {
    expect.assertions(3);
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-create-identity-`);
    let createAttempts = 0;
    const process = processFor([], (command, args) => {
      if (command === "orca" && args[1] === "create") {
        createAttempts += 1;
        return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "identity", "--tmux", "false", "--json"], {
        ...environment(root, "dispatch-create-identity"),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(result.error);
      expect(JSON.parse(result.value).terminalCreateAttempts).toBe(1);
      expect(createAttempts).toBe(1);
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
      expect(result).toEqual({ kind: "failed", error: "command-not-submitted: orca terminal send --terminal child-terminal: command rejected", exitCode: 1 });
      expect(process.calls.some((call) => call.command === "orca" && call.args[1] === "wait")).toBe(false);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta.reason).toBe("command-not-submitted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports the host call and detail when prompt transport fails without leaking the prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-prompt-failure-`);
    const dispatchId = "dispatch-prompt-failure";
    const prompt = "private prompt body that must not appear in the error";
    const process = processFor([], (command, args) => {
      if (command === "orca" && args[1] === "create") return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send" && (args[args.indexOf("--text") + 1] ?? "").includes(prompt)) return failed("prompt rejected", 1);
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", prompt, "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result).toEqual({ kind: "failed", error: "prompt-transport-failed: orca terminal send --terminal child-terminal: prompt rejected", exitCode: 1 });
      if (result.kind === "failed") expect(result.error).not.toContain(prompt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports cleanup failure alongside the primary host command failure", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-cleanup-failure-`);
    const dispatchId = "dispatch-cleanup-failure";
    const process = processFor([], (command, args) => {
      if (command === "orca" && args[1] === "create") return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[1] === "send" && (args[args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID")) return failed("command rejected", 1);
      if (command === "orca" && args[1] === "close") return failed("close rejected", 1);
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "cleanup", "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
      }, process, options(worktree("existing")));
      expect(result).toEqual({ kind: "failed", error: "command-not-submitted: orca terminal send --terminal child-terminal: command rejected; cleanup failed: orca terminal close --terminal child-terminal: close rejected", exitCode: 1 });
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
