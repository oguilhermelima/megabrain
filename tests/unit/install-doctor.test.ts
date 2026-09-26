import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeDoctor } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

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
  mkdirSync(join(stateDir, "dispatches", dispatchId), { recursive: true });
  writeFileSync(join(stateDir, "dispatches", dispatchId, "meta.json"), JSON.stringify({
    dispatchId,
    state: dispatchState,
    processState: "running",
    terminalState: "owned",
    runtime: "host",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt,
    ...extra,
  }));
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

  // Mirrors the shell's untracked-directory scan: a dispatch directory with no meta.json at all
  // gets a notice naming it, while a directory whose meta.json exists but fails to parse ("broken")
  // is excluded from that notice (the shell's own `[ -f meta.json ]` check only tests presence).
  test("surfaces a dispatch directory with no meta.json as untracked, not a malformed one", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-untracked-");
    mkdirSync(join(state, "dispatches", "untracked", "messages"), { recursive: true });
    mkdirSync(join(state, "dispatches", "broken"), { recursive: true });
    writeFileSync(join(state, "dispatches", "broken", "meta.json"), "{ not json");
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
    expect(`${text}${stderr}`).toContain("untracked");
    expect(`${text}${stderr}`).not.toContain("broken");
  });
});

describe("doctor live state", () => {
  test("reports uncertain dispatches as misconfigured", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-dispatch-");
    mkdirSync(join(state, "dispatches", "uncertain"), { recursive: true });
    writeFileSync(join(state, "dispatches", "uncertain", "meta.json"), JSON.stringify({
      dispatchId: "uncertain",
      processState: "start-unproven",
    }));
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
