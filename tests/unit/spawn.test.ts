import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

const codexIdleOutput = "› Ask Codex to do anything";
const claudeIdleOutput = "❯";
const idleOutputFor = (agent: string): string => agent === "claude" ? claudeIdleOutput : codexIdleOutput;

function processFor(events: string[], behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = (command, args) => {
  if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%9\n", stderr: "", exitCode: 0 });
  if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: `${codexIdleOutput}\n`, stderr: "", exitCode: 0 });
  return ok({ stdout: "", stderr: "", exitCode: 0 });
}): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      events.push(`${command} ${args.join(" ")}`);
      const result = await behavior(command, args);
      if (command === "orca" && args[0] === "terminal" && args[1] === "read" && result.kind === "ok" && result.value.stdout === "") {
        return ok({ stdout: JSON.stringify({ result: { terminal: { tail: [codexIdleOutput, claudeIdleOutput] } } }), stderr: "", exitCode: 0 });
      }
      return result;
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

function creationOptions(worktreePath: string | undefined, overrides: Record<string, unknown> = {}): Parameters<typeof defaultResolveWorktree>[1] {
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
  test("accepts the primary repo and branch form and dispatches", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-primary-`);
    const dispatchId = "dispatch-primary";
    let receivedTarget: string | undefined;
    let receivedRepo: string | undefined;
    let receivedBranch: string | undefined;
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined) });
    try {
      const result = await executeSpawn(["--repo", "/repo", "--branch", "feat/primary", "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], environment(root, dispatchId), processFor([]), {
        resolveWorktree: async (target, options) => {
          receivedTarget = target;
          receivedRepo = options.repo;
          receivedBranch = options.branch;
          return ok(worktree("created"));
        },
      });
      expect(result.kind).toBe("ok");
      expect(receivedTarget).toBeUndefined();
      expect(receivedRepo).toBe("/repo");
      expect(receivedBranch).toBe("feat/primary");
      expect(JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`))).toMatchObject({ worktreePath: "/work/tree", branch: "feat/example" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  // Shell parity: megabrain_tmux_send_agent (lib/module-tmux-runtime.sh, last standing at commit
  // 9d24366^) sent a raw `C-u` immediately before typing the launch command line into a freshly
  // created/split pane — its own WHY comment: "the child shell can still hold startup noise or a
  // stray keystroke, and typing onto a non-empty line produced 'mocd <path>' once". That C-u was
  // scoped to exactly that one call site: megabrain_tmux_send_text (used for the prompt payload
  // and for nudges into an already-running agent composer) never sent it — "C-u in an agent
  // composer is not a line kill" is the shell's own reasoning for leaving it out there. This test
  // proves both halves: the launch command line is preceded by a C-u, and the prompt payload sent
  // afterward into the now-running agent's composer is not.
  test("clears stray input with C-u before the launch command line, but never before the prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-clear-stray-`);
    const dispatchId = "dispatch-clear-stray";
    const events: string[] = [];
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
      sendText: async (_pane, text) => {
        events.push(text.includes("MEGABRAIN_DISPATCH_ID=") ? "text:launch-command" : text.includes("[megabrain dispatch:") ? "text:prompt" : `text:${text}`);
        return ok(undefined);
      },
    });
    try {
      const result = await executeSpawn(["--repo", "/repo", "--branch", "feat/clear-stray", "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], environment(root, dispatchId), processFor([]), {
        resolveWorktree: async () => ok(worktree("created")),
      });
      expect(result.kind).toBe("ok");
      const launchIndex = events.indexOf("text:launch-command");
      const promptIndex = events.indexOf("text:prompt");
      expect(launchIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeGreaterThan(launchIndex);
      expect(events[launchIndex - 1]).toBe("key:C-u");
      // No C-u anywhere from the prompt send onward: the composer is a running agent by then.
      expect(events.slice(promptIndex - 1)).not.toContain("key:C-u");
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps accepting an explicit worktree without repo or branch", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-explicit-worktree-`);
    let receivedTarget: string | undefined;
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], environment(root, "dispatch-explicit-worktree"), processFor([]), {
        resolveWorktree: async (target) => {
          receivedTarget = target;
          return ok(worktree("existing"));
        },
      });
      expect(result.kind).toBe("ok");
      expect(receivedTarget).toBe("/work/tree");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a spawn without either accepted worktree form", async () => {
    const result = await executeSpawn(["--agent", "codex", "--prompt", "spawn"], {}, processFor([]));
    expect(result).toEqual({ kind: "failed", error: "either --worktree <path> or --repo <name|path> with --branch <branch> is required", exitCode: 2 });
  });

  test.each([
    ["created", true],
    ["existing", false],
  ] as const)("applies ownership cleanup to the primary form when the launch is %s", async (ownership, removeExpected) => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-primary-cleanup-`);
    const removed: string[] = [];
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => failed("launch failed"), sendKey: async () => ok(undefined) });
    try {
      const result = await executeSpawn(["--repo", "/repo", "--branch", "feat/primary", "--agent", "codex", "--prompt", "fail", "--tmux", "true"], environment(root, `dispatch-primary-cleanup-${ownership}`), processFor([]), {
        resolveWorktree: async () => ok(worktree(ownership)),
        removeWorktree: async (path) => { removed.push(path); return ok(undefined); },
      });
      expect(result.kind).toBe("failed");
      expect(removed).toEqual(removeExpected ? ["/work/tree"] : []);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("keeps --model for the agent command instead of worktree creation", async () => {
    const fixture = await creationFixture({ model: "gpt-5.6-luna" });
    try {
      expect(fixture.result.kind).toBe("ok");
      expect(fixture.calls.every((call) => !call.args.includes("--model"))).toBe(true);

      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-model-command-`);
      const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
        ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      try {
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--model", "gpt-5.6-luna", "--prompt", "spawn", "--tmux", "false"], {
          ...environment(root, "dispatch-model-command"),
          MEGABRAIN_SESSION_HOST: "orca",
        }, process, options(worktree("created")));
        expect(result.kind).toBe("ok");
        const command = process.calls.find((call) => call.command === "orca" && call.args[1] === "send" && (call.args[call.args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID"));
        const text = command?.args[command.args.indexOf("--text") + 1] ?? "";
        expect(text).toContain('-c model="gpt-5.6-luna"');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
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
      expect(text).toContain("MEGABRAIN_NO_TMUX=1");
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
      expect(text).toContain("MEGABRAIN_NO_TMUX=1");
      expect(text).toContain("SUPERSET_TERMINAL_ID='child-terminal'");
      // The launch line now unconditionally clears every caller-identity variable (env -u) before
      // setting the host's own, so "ORCA_TERMINAL_HANDLE" appears as a -u flag; the test's actual
      // intent is that it is never *assigned* a value here.
      expect(text).not.toContain("ORCA_TERMINAL_HANDLE='");
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
      capturePane: async () => ok(codexIdleOutput),
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(result.error);
      expect(result.exitCode).toBe(0);
      expect(events.filter((event) => event.startsWith("text:") || event.startsWith("key:")).slice(-4)).toEqual(["text:command", "key:Enter", "text:prompt", "key:Enter"]);
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ dispatchId, state: "running", promptDelivery: "delivered", promptState: "confirmed", runtime: "tmux", tmuxSession: `megabrain-${dispatchId}`, tmuxPane: "%9" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  // A tmux dispatch's own identity (childHost/terminalId) must describe the CHILD's pane, never
  // the caller that spawned it. Before this fix, terminalId was parentContext.id and childHost
  // was parentContext.host unconditionally — so a caller that later ran findChild (the turn-end
  // hook, on every agent turn; `megabrain done`; `megabrain ack`) against its own just-spawned
  // tmux dispatch would match meta.terminalId === current.id && meta.childHost === current.host,
  // misidentifying itself as that dispatch's own child. Three spawning contexts, since the
  // caller's own identity shape differs across them but the fix must hold regardless.
  describe("tmux child identity never equals the caller's own", () => {
    test("from a structured Orca session (no terminal handle)", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-identity-`);
      const dispatchId = "dispatch-structured";
      const process = processFor([], (command, args) => command === "tmux" && args[0] === "list-panes" ? ok({ stdout: "%11\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const original = getTmux();
      registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok(codexIdleOutput) });
      try {
        const environment = { MEGABRAIN_STATE_DIR: root, ORCA_STRUCTURED_SESSION: "1", MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId, MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" };
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment, process, options(worktree("existing")));
        expect(result.kind).toBe("ok");
        const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
        expect(meta.childHost).toBe("tmux");
        expect(meta.terminalId).toBe(`tmux:megabrain-${dispatchId}:%11`);
        expect(meta.parentSessionId).toBe("");
        expect(meta.parentHost).toBe("orca");
      } finally {
        registerTmux(original);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("from an Orca terminal", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-identity-`);
      const dispatchId = "dispatch-orca-terminal";
      const process = processFor([], (command, args) => command === "tmux" && args[0] === "list-panes" ? ok({ stdout: "%12\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const original = getTmux();
      registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok(codexIdleOutput) });
      try {
        const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term", MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId, MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" };
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment, process, options(worktree("existing")));
        expect(result.kind).toBe("ok");
        const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
        expect(meta.childHost).toBe("tmux");
        expect(meta.terminalId).toBe(`tmux:megabrain-${dispatchId}:%12`);
        expect(meta.parentSessionId).toBe("coord-orca-term");
        expect(meta.parentHost).toBe("orca");
        // The bug this fix corrects: the child's identity must not equal the parent's.
        expect(meta.terminalId).not.toBe(meta.parentSessionId);
        expect(meta.childHost).not.toBe(meta.parentHost);
      } finally {
        registerTmux(original);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("from another tmux pane (splits the caller's own session)", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-identity-`);
      const dispatchId = "dispatch-tmux-parent";
      const process = processFor([], (command, args) => {
        if (command === "tmux" && args[0] === "display-message") return ok({ stdout: "caller-session\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "split-window") return ok({ stdout: "%13\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "has-session") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const original = getTmux();
      registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok(codexIdleOutput) });
      try {
        const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "caller-tmux-server", TMUX_PANE: "%0", MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId, MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" };
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], environment, process, options(worktree("existing")));
        expect(result.kind).toBe("ok");
        const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
        expect(meta.childHost).toBe("tmux");
        expect(meta.tmuxSession).toBe("caller-session");
        expect(meta.tmuxPane).toBe("%13");
        // The caller's OWN pane is %0, in the SAME session; the child's identity names its own
        // split pane %13, never the caller's %0.
        expect(meta.terminalId).toBe("tmux:caller-session:%13");
        expect(meta.parentSessionId).toBe("caller-session:%0");
        expect(meta.parentHost).toBe("tmux");
        expect(meta.terminalId).not.toBe(meta.parentSessionId);
      } finally {
        registerTmux(original);
        await rm(root, { recursive: true, force: true });
      }
    });
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
      capturePane: async () => ok(codexIdleOutput),
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
      : command === "orca" && args[1] === "read"
        ? ok({ stdout: JSON.stringify({ result: { terminal: { tail: ["Working (2s)", "esc to interrupt"] } } }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "claude", "--prompt", "timeout", "--tmux", "false"], {
        ...environment(root, dispatchId),
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "1234",
      }, process, options(worktree("existing")));
      expect(result).toEqual({ kind: "failed", error: "readiness-timeout: orca terminal child-terminal did not become ready within 1234ms", exitCode: 1 });
      const hostCalls = process.calls.filter((call) => call.command === "orca" && (call.args[1] === "send" || call.args[1] === "read"));
      expect(hostCalls[0]?.args[1]).toBe("send");
      expect(hostCalls.filter((call) => call.args[1] === "read").length).toBeGreaterThan(1);
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
      const hostCalls = process.calls.filter((call) => call.command === "orca");
      const commandIndex = hostCalls.findIndex((call) => call.args[1] === "send" && (call.args[call.args.indexOf("--text") + 1] ?? "").includes("MEGABRAIN_DISPATCH_ID"));
      const readinessIndexes = hostCalls.flatMap((call, index) => call.args[1] === "read" ? [index] : []);
      const promptIndex = hostCalls.findIndex((call) => call.args[1] === "send" && (call.args[call.args.indexOf("--text") + 1] ?? "").startsWith("[megabrain dispatch"));
      expect(commandIndex).toBeLessThan(readinessIndexes[0] ?? -1);
      expect(readinessIndexes[readinessIndexes.length - 1] ?? -1).toBeLessThan(promptIndex);
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

  test.each(["codex", "claude"] as const)("submits both the tmux launch line and the initial prompt with Enter regardless of %s's own submit key", async (agent) => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-launch-enter-${agent}-`);
    const events: string[] = [];
    const dispatchId = `dispatch-launch-enter-${agent}`;
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
      capturePane: async () => ok(idleOutputFor(agent)),
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", agent, "--prompt", "do it", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      expect(events.filter((event) => event.startsWith("text:") || event.startsWith("key:")).slice(-4)).toEqual(["text:command", "key:Enter", "text:prompt", "key:Enter"]);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits for tmux readiness before sending the prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-readiness-order-`);
    const events: string[] = [];
    const dispatchId = "dispatch-tmux-readiness-order";
    let captureCalls = 0;
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
      capturePane: async () => {
        captureCalls += 1;
        events.push(`capture:${captureCalls}`);
        return ok(captureCalls < 3 ? "" : codexIdleOutput);
      },
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], {
        ...environment(root, dispatchId),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "2000",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      expect(captureCalls).toBeGreaterThanOrEqual(3);
      const promptIndex = events.indexOf("text:prompt");
      const lastCaptureIndex = events.lastIndexOf(`capture:${captureCalls}`);
      expect(promptIndex).toBeGreaterThan(lastCaptureIndex);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails with a tmux readiness timeout and sends no prompt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-readiness-timeout-`);
    const events: string[] = [];
    const dispatchId = "dispatch-tmux-readiness-timeout";
    const process = processFor(events, (command, args) => command === "tmux" && args[0] === "list-panes"
      ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    const original = getTmux();
    const fake: TmuxProvider = {
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => { events.push(`text:${text.startsWith("[megabrain dispatch") ? "prompt" : "command"}`); return ok(undefined); },
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
      capturePane: async () => ok(""),
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], {
        ...environment(root, dispatchId),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "0",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toContain("readiness-output-invalid");
      expect(events).not.toContain("text:prompt");
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ state: "failed", reason: "readiness-output-invalid" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  // Codex's composer can read idle for one poll and then have something else replace it (the
  // update-check modal from the earlier correction is one example, but the pane can show any
  // transient text) before the next poll. A single idle observation is not proof the composer is
  // still there to receive the prompt, so readiness must see idle hold for a stretch of time
  // (1000ms, two observations at least that far apart with nothing else observed between them)
  // before it is trusted.
  test("does not send the prompt until an idle composer is stable again after an interruption", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-readiness-stability-`);
    const events: string[] = [];
    const dispatchId = "dispatch-tmux-readiness-stability";
    let captureCalls = 0;
    let lastNonIdleAt = 0;
    let promptSentAt = 0;
    const process = processFor(events, (command, args) => command === "tmux" && args[0] === "list-panes"
      ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    const original = getTmux();
    const fake: TmuxProvider = {
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => {
        const isPrompt = text.startsWith("[megabrain dispatch");
        events.push(`text:${isPrompt ? "prompt" : "command"}`);
        if (isPrompt) {
          promptSentAt = Date.now();
          const directory = `${root}/dispatches/${dispatchId}`;
          await mkdir(`${directory}/messages`, { recursive: true });
          await writeFile(`${directory}/messages/9999-child-received.json`, JSON.stringify({ type: "received", from: "child" }));
        }
        return ok(undefined);
      },
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
      capturePane: async () => {
        captureCalls += 1;
        events.push(`capture:${captureCalls}`);
        // idle briefly (calls 3-5), then an interruption (calls 6-7, e.g. an update-check modal
        // replacing the composer), then idle again from call 8 onward until it is stable.
        if (captureCalls <= 2) return ok("");
        if (captureCalls >= 3 && captureCalls <= 5) return ok(codexIdleOutput);
        if (captureCalls === 6 || captureCalls === 7) {
          lastNonIdleAt = Date.now();
          return ok("Update available! 0.155.1 -> 0.156.0\n1. Update now\n2. Skip\nPress enter to continue");
        }
        return ok(codexIdleOutput);
      },
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], {
        ...environment(root, dispatchId),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "5000",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      expect(events).toContain("text:prompt");
      expect(captureCalls).toBeGreaterThan(7);
      // The prompt must land at least 1000ms after the last non-idle observation, proving the
      // composer had to be idle continuously for that long after the interruption, not merely
      // idle again for one poll.
      expect(promptSentAt - lastNonIdleAt).toBeGreaterThanOrEqual(950);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("times out and sends no prompt when the composer never stays idle long enough to be stable", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-readiness-flicker-`);
    const events: string[] = [];
    const dispatchId = "dispatch-tmux-readiness-flicker";
    let captureCalls = 0;
    const process = processFor(events, (command, args) => command === "tmux" && args[0] === "list-panes"
      ? ok({ stdout: "%9\n", stderr: "", exitCode: 0 })
      : ok({ stdout: "", stderr: "", exitCode: 0 }));
    const original = getTmux();
    const fake: TmuxProvider = {
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => { events.push(`text:${text.startsWith("[megabrain dispatch") ? "prompt" : "command"}`); return ok(undefined); },
      sendKey: async (_pane, key) => { events.push(`key:${key}`); return ok(undefined); },
      capturePane: async () => {
        captureCalls += 1;
        // flips every other poll, so idle is never observed twice in a row: it can never
        // accumulate the required 1000ms of stability before the deadline.
        return ok(captureCalls % 2 === 0 ? codexIdleOutput : "Update available! Press enter to continue");
      },
    };
    registerTmux(fake);
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "do it", "--tmux", "true"], {
        ...environment(root, dispatchId),
        MEGABRAIN_AGENT_READY_TIMEOUT_MS: "400",
      }, process, options(worktree("existing")));
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toContain("readiness-output-invalid");
      expect(events).not.toContain("text:prompt");
      const meta = JSON.parse(await readFile(`${root}/dispatches/${dispatchId}/meta.json`, "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ state: "failed", reason: "readiness-output-invalid" });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates the tmux dispatch session without a hardcoded shell command", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-tmux-default-shell-`);
    const dispatchId = "dispatch-tmux-default-shell";
    const process = processFor([]);
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok(codexIdleOutput) });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], environment(root, dispatchId), process, options(worktree("existing")));
      expect(result.kind).toBe("ok");
      const created = process.calls.find((call) => call.command === "tmux" && call.args[0] === "new-session");
      expect(created).toEqual({ command: "tmux", args: ["new-session", "-d", "-A", "-s", `megabrain-${dispatchId}`, "-c", "/work/tree"] });
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  // The budget guards the payload actually transported — finalPrompt(options, id), which wraps
  // the raw --prompt in a fixed "[megabrain dispatch: ...]" preamble plus the dispatch identity —
  // not the raw --prompt value alone. Each wrapper-overhead figure below was measured once by
  // encoding that exact fixed text (agent "codex", worktree "/work/tree", the dispatch id the
  // test uses) with TextEncoder and is asserted here as a plain number so a change to the wrapper
  // text or to a test's dispatch id shows up as a failing byte count instead of silently drifting:
  // "dispatch-budget-tmux-exact" / "dispatch-budget-argv-exact" -> 540 bytes of fixed wrapper text
  // "dispatch-budget-tmux-over" / "dispatch-budget-argv-over" / "dispatch-budget-multibyte" -> 539
  // "dispatch-budget-wrapped-overflow" -> 546
  describe("prompt byte budgets", () => {
    test("accepts a tmux prompt whose wrapped form is exactly at the 12000 byte budget", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-tmux-exact-`);
      const dispatchId = "dispatch-budget-tmux-exact";
      const wrapperOverheadBytes = 540;
      const original = getTmux();
      registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok(codexIdleOutput) });
      try {
        const prompt = "a".repeat(12000 - wrapperOverheadBytes);
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "true"], {
          ...environment(root, dispatchId),
          MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
        }, processFor([]), options(worktree("existing")));
        expect(result.kind).toBe("ok");
      } finally {
        registerTmux(original);
        await rm(root, { recursive: true, force: true });
      }
    });

    test("refuses a tmux prompt whose wrapped form is one byte over the 12000 byte budget without creating anything", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-tmux-over-`);
      const dispatchId = "dispatch-budget-tmux-over";
      const wrapperOverheadBytes = 539;
      let resolveCalled = false;
      const prompt = "a".repeat(12000 - wrapperOverheadBytes + 1);
      try {
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "true"], environment(root, dispatchId), processFor([]), {
          resolveWorktree: async () => { resolveCalled = true; return ok(worktree("existing")); },
        });
        expect(result).toEqual({ kind: "failed", error: "prompt is too large for tmux delivery: 12001 bytes (limit: 12000 bytes)", exitCode: 2 });
        expect(resolveCalled).toBe(false);
        await expect(readdir(`${root}/dispatches`)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("accepts a host prompt whose wrapped form is exactly at the 262144 byte budget", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-argv-exact-`);
      const dispatchId = "dispatch-budget-argv-exact";
      const wrapperOverheadBytes = 540;
      const process = processFor([], (command, args) => command === "orca" && args[1] === "create"
        ? ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      try {
        const prompt = "a".repeat(262144 - wrapperOverheadBytes);
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "false"], {
          ...environment(root, dispatchId),
          MEGABRAIN_SESSION_HOST: "orca",
          MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
        }, process, options(worktree("existing")));
        expect(result.kind).toBe("ok");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("refuses a host prompt whose wrapped form is one byte over the 262144 byte budget without creating anything", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-argv-over-`);
      const dispatchId = "dispatch-budget-argv-over";
      const wrapperOverheadBytes = 539;
      let resolveCalled = false;
      const prompt = "a".repeat(262144 - wrapperOverheadBytes + 1);
      try {
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "false"], { ...environment(root, dispatchId), MEGABRAIN_SESSION_HOST: "orca" }, processFor([]), {
          resolveWorktree: async () => { resolveCalled = true; return ok(worktree("existing")); },
        });
        expect(result).toEqual({ kind: "failed", error: "prompt is too large for argv delivery: 262145 bytes (limit: 262144 bytes)", exitCode: 2 });
        expect(resolveCalled).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("refuses a multibyte tmux prompt that is under the character count but over the byte budget", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-multibyte-`);
      const dispatchId = "dispatch-budget-multibyte";
      const wrapperOverheadBytes = 539;
      let resolveCalled = false;
      const prompt = "é".repeat(7000);
      expect(prompt.length).toBeLessThan(12000);
      expect(new TextEncoder().encode(prompt).length).toBeGreaterThan(12000);
      try {
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "true"], environment(root, dispatchId), processFor([]), {
          resolveWorktree: async () => { resolveCalled = true; return ok(worktree("existing")); },
        });
        expect(result.kind).toBe("failed");
        if (result.kind === "failed") expect(result.error).toContain(`prompt is too large for tmux delivery: ${14000 + wrapperOverheadBytes} bytes (limit: 12000 bytes)`);
        expect(resolveCalled).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("refuses a raw tmux prompt under the limit whose wrapped form exceeds it, without creating anything", async () => {
      const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-budget-wrapped-overflow-`);
      const dispatchId = "dispatch-budget-wrapped-overflow";
      const wrapperOverheadBytes = 546;
      let resolveCalled = false;
      const prompt = "a".repeat(11900);
      expect(new TextEncoder().encode(prompt).length).toBeLessThan(12000);
      try {
        const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", prompt, "--tmux", "true"], environment(root, dispatchId), processFor([]), {
          resolveWorktree: async () => { resolveCalled = true; return ok(worktree("existing")); },
        });
        expect(result).toEqual({ kind: "failed", error: `prompt is too large for tmux delivery: ${11900 + wrapperOverheadBytes} bytes (limit: 12000 bytes)`, exitCode: 2 });
        expect(resolveCalled).toBe(false);
        await expect(readdir(`${root}/dispatches`)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe("defaultResolveWorktree", () => {
  test("scopes named worktree lookup to the selected repository", async () => {
    const process = processFor([], (command, args) => {
      if (command !== "git") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--show-toplevel") return ok({ stdout: "/repo\n", stderr: "", exitCode: 0 });
      if (args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--path-format=absolute") return failed("not a linked worktree", 1);
      if (args.includes("worktree") && args.includes("list")) return ok({ stdout: "worktree /repo/feature-name\nbranch refs/heads/feature-name\n", stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });

    const result = await defaultResolveWorktree("feature-name", creationOptions("feature-name"), {}, process);

    expect(result).toEqual({
      kind: "ok",
      value: { path: "/repo/feature-name", branch: "feature-name", ownership: "existing", workspaceId: null },
    });
    expect(process.calls).toContainEqual({ command: "git", args: ["-C", "/repo", "worktree", "list", "--porcelain"] });
  });

  test("resolves an absolute worktree path without a repository selector", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-existing-path-`);
    const path = await realpath(root);
    const process = processFor([], (command, args) => args.includes("--show-toplevel")
      ? ok({ stdout: `${path}\n`, stderr: "", exitCode: 0 })
      : args.includes("symbolic-ref")
        ? ok({ stdout: "feat/existing\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await defaultResolveWorktree(root, creationOptions(root, { repo: undefined }), {}, process);

      expect(result).toEqual({
        kind: "ok",
        value: { path, branch: "feat/existing", ownership: "existing", workspaceId: null },
      });
      expect(process.calls).not.toContainEqual({ command: "git", args: ["worktree", "list", "--porcelain"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a named worktree lookup without a repository selector", async () => {
    const process = processFor([]);

    const result = await defaultResolveWorktree("feature-name", creationOptions("feature-name", { repo: undefined }), {}, process);

    expect(result).toEqual({ kind: "failed", error: "--repo is required to resolve a worktree by name", exitCode: 1 });
    expect(process.calls).toEqual([]);
  });
});

// Regression coverage for the shell-parity bug in tests/test-spawn-runtime.sh: omitting --tmux
// used to always resolve to "host" because MEGABRAIN_SPAWN_RUNTIME (the env var the old
// expression read) was never set anywhere. These prove the wiring — not just the pure
// resolveAutoSpawnRuntime decision covered in spawn-plan.test.ts — actually reads the
// tmux-runtime module's installed flag out of state.json and routes to the matching host command.
describe("executeSpawn: auto runtime resolution with no --tmux flag", () => {
  test("routes to a tmux pane operation when the tmux-runtime module reports itself installed", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-auto-tmux-`);
    const state = `${root}/state`;
    await mkdir(state, { recursive: true });
    await writeFile(`${state}/state.json`, JSON.stringify({ "tmux-runtime": { installed: true } }));
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => ok(undefined), sendKey: async () => ok(undefined) });
    try {
      const process = processFor([]);
      await executeSpawn(
        ["--repo", "/repo", "--branch", "feat/auto-tmux", "--agent", "codex", "--prompt", "spawn"],
        { MEGABRAIN_STATE_DIR: state, ORCA_TERMINAL_HANDLE: "parent-terminal", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-auto-tmux", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" },
        process,
        { resolveWorktree: async () => ok(worktree("created")) },
      );
      expect(process.calls.some((call) => call.command === "tmux")).toBe(true);
      expect(process.calls.some((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "create")).toBe(false);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes to a host terminal (orca terminal create) when the tmux-runtime module is not installed", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-auto-host-`);
    const state = `${root}/state`;
    // No state.json at all: the tmux-runtime module has never been installed for this state dir.
    await mkdir(state, { recursive: true });
    try {
      const process = processFor([]);
      await executeSpawn(
        ["--repo", "/repo", "--branch", "feat/auto-host", "--agent", "codex", "--prompt", "spawn"],
        { MEGABRAIN_STATE_DIR: state, ORCA_TERMINAL_HANDLE: "parent-terminal", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-auto-host", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" },
        process,
        { resolveWorktree: async () => ok(worktree("created")) },
      );
      expect(process.calls.some((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "create")).toBe(true);
      expect(process.calls.some((call) => call.command === "tmux")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a malformed state.json is treated as not installed, matching the shell's own guard", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-auto-malformed-`);
    const state = `${root}/state`;
    await mkdir(state, { recursive: true });
    await writeFile(`${state}/state.json`, "{ not json");
    try {
      const process = processFor([]);
      await executeSpawn(
        ["--repo", "/repo", "--branch", "feat/auto-malformed", "--agent", "codex", "--prompt", "spawn"],
        { MEGABRAIN_STATE_DIR: state, ORCA_TERMINAL_HANDLE: "parent-terminal", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-auto-malformed", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" },
        process,
        { resolveWorktree: async () => ok(worktree("created")) },
      );
      expect(process.calls.some((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "create")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an explicit --tmux still wins over the module's installed flag", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-explicit-over-auto-`);
    const state = `${root}/state`;
    await mkdir(state, { recursive: true });
    await writeFile(`${state}/state.json`, JSON.stringify({ "tmux-runtime": { installed: true } }));
    try {
      const process = processFor([]);
      await executeSpawn(
        ["--repo", "/repo", "--branch", "feat/explicit-host", "--agent", "codex", "--prompt", "spawn", "--tmux", "false"],
        { MEGABRAIN_STATE_DIR: state, ORCA_TERMINAL_HANDLE: "parent-terminal", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-explicit-host", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" },
        process,
        { resolveWorktree: async () => ok(worktree("created")) },
      );
      expect(process.calls.some((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "create")).toBe(true);
      expect(process.calls.some((call) => call.command === "tmux")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
