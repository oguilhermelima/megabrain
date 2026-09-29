import { guardedStateDatabase } from "./state-db-guard.js";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { createDispatch } from "../../src/adapters/state-db.js";

function processFor(values: Record<string, string>): ProcessAdapter {
  return {
    async run(command, args) {
      const key = [command, ...args].join(" ");
      if (key in values) return ok({ stdout: values[key], stderr: "", exitCode: 0 });
      if (command === "which") return ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${key} unavailable`);
    },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => 0,
  };
}

function report(result: Awaited<ReturnType<typeof executeDoctor>>) {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("doctor failed");
  return JSON.parse(result.value) as { status: string; reason: string; uncertainDispatches: number };
}

function writeDispatchMeta(stateDir: string, dispatchId: string, dispatchState: string, updatedAt: string, extra: Record<string, unknown> = {}): void {
  const opened = guardedStateDatabase({ MEGABRAIN_STATE_DIR: stateDir });
  if (opened.kind !== "ok") throw new Error(opened.error);
  const result = createDispatch(opened.value, {
    dispatchId,
    state: dispatchState,
    processState: "running",
    terminalState: "owned",
    runtime: "host",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt,
    ...extra,
  });
  if (result.kind !== "ok") throw new Error(result.error);
}

describe("doctor orchestration health counts (shell parity)", () => {
  // Mirrors the shell's megabrain_dispatch_health_counts: a dispatch is prunable when its state is
  // terminal (closed/done/failed/orphaned/circuit_broken) AND its updatedAt (or createdAt when
  // updatedAt is absent) is at or before now minus the default 7-day window. A still-open
  // ("running") dispatch and a terminal dispatch updated far in the future are both excluded.
  test("counts prunable dispatches: terminal and old, excluding open and too-recent", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-prunable-");
    writeDispatchMeta(state, "old-closed", "closed", "2020-01-01T00:00:00Z");
    writeDispatchMeta(state, "old-done", "done", "2020-01-01T00:00:00Z");
    writeDispatchMeta(state, "old-failed", "failed", "2020-01-01T00:00:00Z");
    writeDispatchMeta(state, "still-running", "running", "2020-01-01T00:00:00Z");
    writeDispatchMeta(state, "recent-closed", "closed", "2999-01-01T00:00:00Z");
    const result = report(await executeDoctor(["orchestration", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
    }, processFor({
      "orca status --json": "{}",
      "superset workspaces list --json": "{}",
    })));
    expect((result as unknown as { prunableDispatches: number }).prunableDispatches).toBe(3);
  });

  // Untracked and malformed JSON directories have no database representation; the equivalent
  // database assertion is that an empty dispatch table produces no JSON-layout warning.
  test("does not report untracked or malformed JSON directories after cutover", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-untracked-");
    const outcome = await executeDoctor(["orchestration", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
    }, processFor({
      "orca status --json": "{}",
      "superset workspaces list --json": "{}",
    }));
    expect(outcome.kind).toBe("ok");
    const text = outcome.kind === "ok" ? outcome.value : "";
    const stderr = outcome.kind === "ok" ? (outcome.stderr ?? "") : "";
    expect(`${text}${stderr}`).not.toContain("untracked");
    expect(`${text}${stderr}`).not.toContain("broken");
  });
});

describe("doctor live state", () => {
  test("reports uncertain dispatches as misconfigured", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-dispatch-");
    writeDispatchMeta(state, "uncertain", "running", "2020-01-01T00:00:00Z", { processState: "start-unproven" });
    const result = report(await executeDoctor(["orchestration", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
    }, processFor({
      "orca status --json": "{}",
      "superset workspaces list --json": "{}",
    })));
    expect(result.status).toBe("misconfigured");
    expect(result.uncertainDispatches).toBe(1);
    expect(result.reason).toContain("dispatch state requires reconciliation");
  });

  test("preserves unknown browser state when an extension is behind", async () => {
    const root = mkdtempSync("/tmp/megabrain-doctor-web-");
    const state = mkdtempSync("/tmp/megabrain-doctor-state-");
    mkdirSync(join(root, "node_modules", "playwright"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), "{}\n");
    writeFileSync(join(root, "node_modules", "playwright", "package.json"), JSON.stringify({ version: "1.62.1" }));
    const result = report(await executeDoctor(["simulator-web", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
      MEGABRAIN_PLAYWRIGHT_ROOT: root,
    }, processFor({
      [`node ${resolve("scripts/playwright-web.mjs")} doctor --root ${root}`]: JSON.stringify({
        status: "unknown",
        reason: "chromium.ublock: installed 2026.907.2003, expected 2026.914.1325",
      }),
    })));
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("chromium.ublock");
  });
});

describe("doctor orchestration-hooks entry detection", () => {
  // Detection must recognise both the legacy megabrain-turn-end.sh path (no longer installed by
  // this binary, but still found in configs left by an older install) and the current direct
  // binary command. A legacy match is not "entry-present": it is a distinct, actionable state
  // that names the fix, because the wrapper script it points at has been deleted.
  test("reports a legacy megabrain-turn-end.sh entry as needing migration, not entry-present", async () => {
    const home = mkdtempSync("/tmp/megabrain-doctor-hooks-legacy-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "MEGABRAIN_HOOK_AGENT=claude /some/checkout/hooks/megabrain-turn-end.sh" }] }] },
    }));
    const result = report(await executeDoctor(["orchestration-hooks", "--json"], { HOME: home }, processFor({})));
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toContain("claude: legacy entry; run megabrain install orchestration-hooks to migrate");
    expect(result.reason).not.toContain("claude: entry-present");
  });

  test("reports an entry that already invokes the compiled binary directly as entry-present", async () => {
    const home = mkdtempSync("/tmp/megabrain-doctor-hooks-binary-");
    const entrypoint = join(home, "checkout/.build/megabrain");
    mkdirSync(join(home, "checkout/.build"), { recursive: true });
    writeFileSync(entrypoint, "#!/usr/bin/env node\n");
    chmodSync(entrypoint, 0o755);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `MEGABRAIN_HOOK_AGENT=claude ${entrypoint} hook turn-end` }] }] },
    }));
    const result = report(await executeDoctor(["orchestration-hooks", "--json"], { HOME: home }, processFor({})));
    expect(result.reason).toContain("claude: entry-present");
  });

  test("reports a quoted extensionless Node entrypoint hook as entry-present", async () => {
    const home = mkdtempSync("/tmp/megabrain-doctor-hooks-node-");
    const node = join(home, "Node Runtime/bin/node");
    const entrypoint = join(home, "megabrain package/.build/megabrain");
    mkdirSync(join(home, "Node Runtime/bin"), { recursive: true });
    mkdirSync(join(home, "megabrain package/.build"), { recursive: true });
    writeFileSync(node, "node");
    writeFileSync(entrypoint, "bundle");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `MEGABRAIN_HOOK_AGENT=claude '${node}' '${entrypoint}' hook turn-end` }] }] },
    }));
    const result = report(await executeDoctor(["orchestration-hooks", "--json"], { HOME: home }, processFor({})));
    expect(result.reason).toContain("claude: entry-present");
  });

  test("reports when the Node interpreter path has disappeared", async () => {
    const home = mkdtempSync("/tmp/megabrain-doctor-hooks-missing-node-");
    const entrypoint = join(home, "checkout/.build/megabrain");
    mkdirSync(join(home, "checkout/.build"), { recursive: true });
    writeFileSync(entrypoint, "bundle");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `MEGABRAIN_HOOK_AGENT=claude '${join(home, "old-node/bin/node")}' '${entrypoint}' hook turn-end` }] }] },
    }));
    const result = report(await executeDoctor(["orchestration-hooks", "--json"], { HOME: home }, processFor({})));
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toContain("claude: interpreter missing");
    expect(result.reason).toContain("megabrain install");
  });

  test("reports when the Node entrypoint path has disappeared", async () => {
    const home = mkdtempSync("/tmp/megabrain-doctor-hooks-missing-entrypoint-");
    const node = join(home, "Node Runtime/bin/node");
    mkdirSync(join(home, "Node Runtime/bin"), { recursive: true });
    writeFileSync(node, "node");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `MEGABRAIN_HOOK_AGENT=claude '${node}' '${join(home, "deleted/.build/megabrain")}' hook turn-end` }] }] },
    }));
    const result = report(await executeDoctor(["orchestration-hooks", "--json"], { HOME: home }, processFor({})));
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toContain("claude: entrypoint missing");
    expect(result.reason).toContain("megabrain install");
  });
});

describe("install orchestration-hooks backups", () => {
  test("backs up an existing config once, before the first install", async () => {
    const home = mkdtempSync("/tmp/megabrain-install-hooks-backup-");
    const configDir = join(home, ".claude");
    const config = join(configDir, "settings.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(config, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "which") return args[0] === "claude"
          ? ok({ stdout: "/usr/bin/claude", stderr: "", exitCode: 0 })
          : failed(`${args[0]} unavailable`);
        if (command === "date") return ok({ stdout: "20260926T000000Z\n", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("detached process unavailable"); },
      invocationCount: () => 0,
    };

    const environment = { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state") };
    const first = await executeInstall(["orchestration-hooks"], environment, process);
    expect(first.kind).toBe("ok");
    const second = await executeInstall(["orchestration-hooks"], environment, process);
    expect(second.kind).toBe("ok");

    const backups = readdirSync(configDir).filter((name) => name.startsWith("settings.json.megabrain-backup-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(configDir, backups[0]!), "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] },
    });
  });
});

describe("revert orchestration-hooks", () => {
  function hookProcess(...availableAgents: string[]): ProcessAdapter {
    return {
      async run(command, args) {
        if (command === "which") return availableAgents.includes(args[0] ?? "")
          ? ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 })
          : failed(`${args[0]} unavailable`);
        if (command === "date") return ok({ stdout: "20260926T010000Z\n", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("detached process unavailable"); },
      invocationCount: () => 0,
    };
  }

  test("restores the original config when no other changes were made", async () => {
    const home = mkdtempSync("/tmp/megabrain-revert-hooks-restore-");
    const directory = join(home, ".claude");
    const config = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    const original = '{\n  "theme": "dark",\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "user-hook"}]}]}\n}\n';
    writeFileSync(config, original);
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state") };

    expect((await executeInstall(["orchestration-hooks"], environment, hookProcess("claude"))).kind).toBe("ok");
    const reverted = await executeInstall(["orchestration-hooks", "--revert"], environment, hookProcess());

    expect(reverted.kind).toBe("ok");
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  test("removes only megabrain entries and preserves later user hooks", async () => {
    const home = mkdtempSync("/tmp/megabrain-revert-hooks-merge-");
    const directory = join(home, ".claude");
    const config = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    writeFileSync(config, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } }));
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state") };
    expect((await executeInstall(["orchestration-hooks"], environment, hookProcess("claude"))).kind).toBe("ok");

    const current = JSON.parse(readFileSync(config, "utf8")) as { hooks: { Stop: Array<{ hooks: unknown[] }> } };
    current.hooks.Stop.push({ hooks: [{ type: "command", command: "added-later" }] });
    writeFileSync(config, JSON.stringify(current));
    const reverted = await executeInstall(["orchestration-hooks", "--revert"], environment, hookProcess());

    expect(reverted.kind).toBe("ok");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }, { hooks: [{ type: "command", command: "added-later" }] }] },
    });
  });

  test("deletes a config created by install when no content remains", async () => {
    const home = mkdtempSync("/tmp/megabrain-revert-hooks-created-");
    const directory = join(home, ".claude");
    const config = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state") };

    expect((await executeInstall(["orchestration-hooks"], environment, hookProcess("claude"))).kind).toBe("ok");
    const reverted = await executeInstall(["orchestration-hooks", "--revert"], environment, hookProcess());

    expect(reverted.kind).toBe("ok");
    expect(existsSync(config)).toBe(false);
  });
});

describe("install orchestration with dispatches that need review", () => {
  // Orchestration installs nothing of its own; a usable runtime is the whole requirement. A leftover
  // record that needs reconciling is reported, but it must not turn the install into a failure.
  test("succeeds with a warning when a runtime is usable, and still fails when none is", async () => {
    const { executeInstall } = await import("../../src/cli/commands/install-doctor.js");
    const state = mkdtempSync("/tmp/megabrain-install-orchestration-");
    writeDispatchMeta(state, "unproven", "running", "2020-01-01T00:00:00Z", { processState: "start-unproven" });

    const withRuntime = await executeInstall(["orchestration"], { HOME: state, MEGABRAIN_STATE_DIR: state }, processFor({
      "orca status --json": "{}",
    }));
    expect(withRuntime.kind).toBe("ok");
    if (withRuntime.kind === "ok") expect(withRuntime.value).toContain("orchestration: ok (warning: dispatch state requires reconciliation");

    const noRuntime: ProcessAdapter = {
      async run(command) { return failed(`${command} unavailable`); },
      async startDetached() { return failed("detached process unavailable"); },
      invocationCount: () => 0,
    };
    const withoutRuntime = await executeInstall(["orchestration"], { HOME: state, MEGABRAIN_STATE_DIR: state }, noRuntime);
    expect(withoutRuntime.kind).toBe("failed");
  });
});
