import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeChainRun, type ChainRunDependencies } from "../../src/cli/commands/chain-run.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = () => ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return behavior(command, args);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

async function withRoot<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-${prefix}-`);
  try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "chains.json"), JSON.stringify(config));
}

function environment(root: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  // MEGABRAIN_ROOT points at a directory with no .megabrain/models.json, so
  // validateConfig treats the registry as absent and skips model validation —
  // these tests exercise chain selection and step-walking, not the model registry.
  return { MEGABRAIN_STATE_DIR: root, HOME: root, MEGABRAIN_ROOT: root, ...extra };
}

const okSpawn = (dispatchId = "dispatch-1"): ChainRunDependencies["spawn"] => async () => ok(`${JSON.stringify({ dispatchId })}\n`);
const failSpawn = (message: string): ChainRunDependencies["spawn"] => async () => failed(message);

async function writeRollout(sessionsDir: string, name: string, usedPercent: number, resetsAt: number, windowMinutes = 300): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: windowMinutes, resets_at: resetsAt } } } });
  await writeFile(join(sessionsDir, name), `${line}\n`);
}

describe("executeChainRun: argument validation", () => {
  test("requires a prompt", async () => {
    const result = await executeChainRun(["--repo", "r", "--branch", "b"], {}, fakeProcess());
    expect(result).toEqual({ kind: "failed", error: "--prompt is required for chain run", exitCode: 2 });
  });

  test("requires repo and branch unless a worktree is given", async () => {
    const noRepo = await executeChainRun(["--branch", "b", "--prompt", "p"], {}, fakeProcess());
    expect(noRepo).toEqual({ kind: "failed", error: "--repo is required for chain run unless --worktree is used", exitCode: 2 });
    const noBranch = await executeChainRun(["--repo", "r", "--prompt", "p"], {}, fakeProcess());
    expect(noBranch).toEqual({ kind: "failed", error: "--branch is required for chain run unless --worktree is used", exitCode: 2 });
  });

  test("rejects a positional name together with --chain", async () => {
    const result = await executeChainRun(["mine", "--chain", "other", "--worktree", "/w", "--prompt", "p"], {}, fakeProcess());
    expect(result).toEqual({ kind: "failed", error: "chain run accepts either a positional chain name or --chain, not both", exitCode: 2 });
  });

  test("rejects an unknown option", async () => {
    const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--bogus"], {}, fakeProcess());
    expect(result).toEqual({ kind: "failed", error: "unknown chain run option: --bogus", exitCode: 2 });
  });
});

describe("executeChainRun: selection", () => {
  test("reports the chain not found for an explicit name", async () => {
    await withRoot("select-missing", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [] });
      const result = await executeChainRun(["missing", "--worktree", "/w", "--prompt", "p"], environment(root), fakeProcess());
      expect(result).toEqual({ kind: "failed", error: "chain not found: missing; list chains with megabrain chain list", exitCode: 1 });
    });
  });

  test("reports an ambiguous selector tie with its candidates", async () => {
    await withRoot("select-tie", async (root) => {
      const step = { agent: "codex", model: "m" };
      await writeConfig(root, { chains: { a: { when: { parentAgent: "codex" }, steps: [step] }, b: { when: { parentAgent: "codex" }, steps: [step] } }, defaultSteps: [] });
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p"], environment(root), fakeProcess());
      expect(result).toEqual({ kind: "failed", error: "chain selection is ambiguous: candidates: a, b", exitCode: 1 });
    });
  });

  test("reports 'no usable chain steps' when defaultSteps is empty and nothing matches", async () => {
    await withRoot("select-empty", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [] });
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess());
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("megabrain: no usable chain steps; add a chain with megabrain chain add");
      expect(JSON.parse(result.value)).toEqual({ ok: false, chain: "defaultSteps", totalSteps: 0, reason: "chain has no usable steps; add a chain with megabrain chain add", skipped: [] });
    });
  });

  test("carries the explicit-name and explicit-flag selection reasons into a successful report", async () => {
    await withRoot("select-reason", async (root) => {
      const config = { chains: { mine: { when: { parentAgent: "codex" }, steps: [{ agent: "codex", model: "m" }] } }, defaultSteps: [] };
      await writeConfig(root, config);
      const byPositional = await executeChainRun(["mine", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(byPositional.kind).toBe("ok");
      if (byPositional.kind === "ok") expect(JSON.parse(byPositional.value).reason).toContain("explicit name given");
      const byFlag = await executeChainRun(["--chain", "mine", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(byFlag.kind).toBe("ok");
      if (byFlag.kind === "ok") expect(JSON.parse(byFlag.value).reason).toContain("explicit --chain requested");
    });
  });

  test("falls back to defaultSteps and names the reason when nothing matches", async () => {
    await withRoot("select-default", async (root) => {
      await writeConfig(root, { chains: { other: { when: { parentAgent: "claude" }, steps: [{ agent: "claude", model: "m" }] } }, defaultSteps: [{ agent: "codex", model: "m" }] });
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const body = JSON.parse(result.value);
        expect(body.chain).toBe("defaultSteps");
        expect(body.reason).toContain("used defaultSteps");
      }
    });
  });
});

describe("executeChainRun: step walking", () => {
  test("advances past a step skipped by an exhausted current limit and reports the reset", async () => {
    await withRoot("walk-threshold", async (root) => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      await writeRollout(join(root, ".codex/sessions"), "rollout-a.jsonl", 97.0, future);
      await writeConfig(root, {
        chains: { run: { when: { parentAgent: "codex" }, steps: [
          { agent: "codex", model: "m1", until: { usedPercent: 95, window: "5h" } },
          { agent: "agy", model: "m2" },
        ] } },
        defaultSteps: [],
      });
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const body = JSON.parse(result.value);
      expect(body.step).toBe(2);
      expect(body.agent).toBe("agy");
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].kind).toBe("limit");
      expect(body.skipped[0].reason).toContain("97.0");
      expect(body.skipped[0].reason).toContain("resets at");
    });
  });

  test("skips a step whose limit is unknown when onUnknown is skip", async () => {
    await withRoot("walk-unknown-skip", async (root) => {
      await writeConfig(root, {
        chains: { run: { when: { parentAgent: "codex" }, steps: [
          { agent: "codex", model: "m1", until: { usedPercent: 95, window: "5h", onUnknown: "skip" } },
          { agent: "agy", model: "m2" },
        ] } },
        defaultSteps: [],
      });
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const body = JSON.parse(result.value);
      expect(body.step).toBe(2);
      expect(body.skipped[0].kind).toBe("limit");
      expect(body.skipped[0].reason).toContain("no rate limit snapshot");
    });
  });

  test("takes a step whose limit is unknown by default and warns on stderr", async () => {
    await withRoot("walk-unknown-take", async (root) => {
      await writeConfig(root, {
        chains: { run: { when: { parentAgent: "codex" }, steps: [
          { agent: "codex", model: "m1", until: { usedPercent: 95, window: "5h" } },
        ] } },
        defaultSteps: [],
      });
      const attempted: string[] = [];
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), {
        spawn: async (args) => { attempted.push(args.join(" ")); return okSpawn()!(args, {}, fakeProcess()); },
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.stderr).toContain("usage limit is unknown; taking step (onUnknown=take)");
      expect(attempted).toHaveLength(1);
      expect(JSON.parse(result.value).step).toBe(1);
    });
  });

  test("advances past a launch failure and records the failure reason", async () => {
    await withRoot("walk-failure", async (root) => {
      await writeConfig(root, {
        chains: { run: { when: { parentAgent: "codex" }, steps: [
          { agent: "claude", model: "m1" },
          { agent: "agy", model: "m2" },
        ] } },
        defaultSteps: [],
      });
      let calls = 0;
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), {
        spawn: async (args) => { calls += 1; return calls === 1 ? failed("launch failed") : okSpawn()!(args, {}, fakeProcess()); },
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const body = JSON.parse(result.value);
      expect(body.step).toBe(2);
      expect(body.skipped[0].kind).toBe("failure");
      expect(body.skipped[0].reason).toBe("claude launch failed: launch failed");
    });
  });

  test("reports exhaustion when every step is unusable", async () => {
    await withRoot("walk-exhaustion", async (root) => {
      await writeConfig(root, {
        chains: { run: { when: { parentAgent: "codex" }, steps: [
          { agent: "codex", model: "m1" },
          { agent: "agy", model: "m2" },
        ] } },
        defaultSteps: [],
      });
      const result = await executeChainRun(["--parent-agent", "codex", "--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: failSpawn("launch failed") });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.exitCode).toBe(1);
      const body = JSON.parse(result.value);
      expect(body.ok).toBe(false);
      expect(body.skipped).toHaveLength(2);
    });
  });

  test("prints the plain-text report with the raw dispatch line", async () => {
    await withRoot("walk-plain", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }] });
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p"], environment(root), fakeProcess(), { spawn: okSpawn("dispatch-plain") });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.value).toBe(`chain defaultSteps, step 1 of 1, reason: used defaultSteps; no earlier steps skipped\n${JSON.stringify({ dispatchId: "dispatch-plain" })}\n`);
    });
  });
});

describe("executeChainRun: codex rollout scan", () => {
  test("reports an absent snapshot honestly", async () => {
    await withRoot("codex-absent", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "codex", model: "m1", until: { usedPercent: 95, window: "5h" } }] });
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.stderr).toContain("usage limit is unknown; taking step");
      expect(JSON.parse(result.value).reason).toContain("no rate limit snapshot");
    });
  });

  test("treats a reset-in-the-past snapshot as unknown, not stale", async () => {
    await withRoot("codex-reset", async (root) => {
      const past = Math.floor(Date.now() / 1000) - 60;
      await writeRollout(join(root, ".codex/sessions"), "rollout-a.jsonl", 99.0, past);
      await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "codex", model: "m1", until: { usedPercent: 95, window: "5h", onUnknown: "skip" } }] });
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--json"], environment(root), fakeProcess(), { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const body = JSON.parse(result.value);
      expect(body.reason).toContain("already reset");
      expect(body.reason).not.toContain("stale");
    });
  });
});

describe("executeChainRun: claude/agy live limits", () => {
  test("makes no request when the provider is not opted in", async () => {
    await withRoot("live-disabled", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "claude", model: "m1", until: { usedPercent: 5, window: "5h", onUnknown: "skip" } }] });
      const process = fakeProcess();
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--json"], environment(root), process, { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(JSON.parse(result.value).skipped[0].reason).toContain("not enabled");
      expect(process.calls.some((call) => call.command === "curl")).toBe(false);
    });
  });

  test("fetches live usage once and reuses the cache for a second window read", async () => {
    await withRoot("live-cache", async (root) => {
      await writeConfig(root, {
        chains: {}, defaultSteps: [
          { agent: "claude", model: "m1", until: { usedPercent: 5, window: "5h", onUnknown: "skip" } },
          { agent: "claude", model: "m2", until: { usedPercent: 5, window: "weekly", onUnknown: "skip" } },
        ],
        usageLimits: { liveProviders: ["claude"], cacheTtlSeconds: 30, timeoutSeconds: 5, notice: { enabled: false, intervalSeconds: 3600 } },
      });
      const process = fakeProcess((command) => {
        if (command === "security") return ok({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: 9999999999 } }), stderr: "", exitCode: 0 });
        if (command === "curl") return ok({ stdout: `${JSON.stringify({ five_hour: { utilization: 11.0, resets_at: "2026-09-07T10:00:00Z" }, seven_day: { utilization: 48.0, resets_at: "2026-09-10T16:00:00Z" } })}\nMEGABRAIN_HTTP_STATUS:200`, stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "p", "--json"], environment(root), process, { spawn: okSpawn() });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const body = JSON.parse(result.value);
      expect(body.skipped).toHaveLength(2);
      expect(body.skipped[0].reason).toContain("11.0");
      expect(body.skipped[1].reason).toContain("48.0");
      expect(process.calls.filter((call) => call.command === "curl")).toHaveLength(1);
    });
  });
});

describe("executeChainRun: dispatch side effects", () => {
  test("queues the usage notice mail when due and leaves an unset chain context alone", async () => {
    await withRoot("notice", async (root) => {
      await writeConfig(root, {
        chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }],
        usageLimits: { liveProviders: [], cacheTtlSeconds: 30, timeoutSeconds: 5, notice: { enabled: true, intervalSeconds: 3600 } },
      });
      const dispatchDir = join(root, "dispatches", "dispatch-notice");
      await mkdir(dispatchDir, { recursive: true });
      await writeFile(join(dispatchDir, "meta.json"), JSON.stringify({ dispatchId: "dispatch-notice", chain: null }));
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "notice-prompt", "--json"], environment(root), fakeProcess(), { spawn: okSpawn("dispatch-notice") });
      expect(result.kind).toBe("ok");
      const { readdir } = await import("node:fs/promises");
      const messages = await readdir(join(dispatchDir, "messages")).catch(() => []);
      expect(messages.length).toBeGreaterThan(0);
      const text = await readFile(join(dispatchDir, "messages", messages[0]), "utf8");
      expect(JSON.parse(text).text).toContain("Usage limits:");
      const meta = JSON.parse(await readFile(join(dispatchDir, "meta.json"), "utf8"));
      expect(meta.chain).toBeNull();
    });
  });

  test("merges the prompt into an already-established chain context", async () => {
    await withRoot("chain-context", async (root) => {
      await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }] });
      const dispatchDir = join(root, "dispatches", "dispatch-ctx");
      await mkdir(dispatchDir, { recursive: true });
      await writeFile(join(dispatchDir, "meta.json"), JSON.stringify({ dispatchId: "dispatch-ctx", chain: { name: "defaultSteps", step: 1, total: 1 } }));
      const result = await executeChainRun(["--worktree", "/w", "--prompt", "carried-prompt", "--json"], environment(root), fakeProcess(), { spawn: okSpawn("dispatch-ctx") });
      expect(result.kind).toBe("ok");
      const meta = JSON.parse(await readFile(join(dispatchDir, "meta.json"), "utf8"));
      expect(meta.chain).toMatchObject({ name: "defaultSteps", prompt: "carried-prompt" });
    });
  });
});

describe("executeChainRun: in-process spawn hand-off", () => {
  test("reaches the real orchestrate spawn in-process, never shelling out to the compiled binary", async () => {
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
      capturePane: async () => ok("› Ask Codex to do anything"),
    });
    try {
      await withRoot("in-process", async (root) => {
        const worktreeDir = await mkdtemp(`${tmpdir()}/megabrain-chain-run-worktree-`);
        try {
          await writeConfig(root, { chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }] });
          const resolved = await realpath(worktreeDir);
          const process = fakeProcess((command, args) => {
            if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: `${resolved}\n`, stderr: "", exitCode: 0 });
            if (command === "git" && args.includes("symbolic-ref")) return ok({ stdout: "feat/chain\n", stderr: "", exitCode: 0 });
            if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%9\n", stderr: "", exitCode: 0 });
            return ok({ stdout: "", stderr: "", exitCode: 0 });
          });
          const result = await executeChainRun(["--worktree", worktreeDir, "--prompt", "p", "--tmux", "true", "--json"], environment(root, { MEGABRAIN_SESSION_ID: "parent-terminal", MEGABRAIN_SESSION_HOST: "tmux", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" }), process);
          expect(result.kind).toBe("ok");
          if (result.kind !== "ok") return;
          const body = JSON.parse(result.value);
          expect(body.ok).toBe(true);
          expect(typeof body.dispatch.dispatchId).toBe("string");
          expect(process.calls.some((call) => call.command.includes("megabrain"))).toBe(false);
          const meta = JSON.parse(await readFile(join(root, "dispatches", body.dispatch.dispatchId, "meta.json"), "utf8"));
          expect(meta).toMatchObject({ agent: "codex", model: "m1", worktreePath: resolved });
        } finally {
          await rm(worktreeDir, { recursive: true, force: true });
        }
      });
    } finally {
      registerTmux(original);
    }
  });
});
