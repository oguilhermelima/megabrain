import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOrchestratePrune } from "../../src/cli/commands/orchestrate-prune.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

const oldDate = "2020-01-01T00:00:00.000Z";

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>, calls: string[] = []): ProcessAdapter {
  return {
    async run(command, args) { calls.push(`${command} ${args.join(" ")}`); return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

async function fixture(meta: Record<string, unknown>): Promise<{ root: string; directory: string; metaPath: string }> {
  const dispatchId = String(meta.dispatchId ?? "dispatch-1");
  const root = await mkdtemp(join(tmpdir(), "megabrain-prune-terminal-proof-"));
  const directory = join(root, "dispatches", dispatchId);
  await mkdir(directory, { recursive: true });
  const metaPath = join(directory, "meta.json");
  await writeFile(metaPath, `${JSON.stringify({ dispatchId, state: "done", createdAt: oldDate, updatedAt: oldDate, terminalState: "owned", ...meta })}\n`);
  return { root, directory, metaPath };
}

const env = (root: string) => ({ MEGABRAIN_STATE_DIR: root });
const unprovenHost = () => fakeProcess((command, args) => command === "orca" && args[0] === "terminal" && args[1] === "close"
  ? failed("terminal close denied", 1)
  : ok({ stdout: "[]\n", stderr: "", exitCode: 0 }));

describe("orchestrate prune terminal proof", () => {
  test("keeps a host dispatch when a valid listing omits its terminal and records the reason", async () => {
    const f = await fixture({ childHost: "orca", runtime: "host", terminalId: "child-terminal", workspaceId: "workspace" });
    try {
      const result = await executeOrchestratePrune(["--json"], env(f.root), unprovenHost());

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const output = JSON.parse(result.value) as Record<string, unknown>;
        expect(output.archived).toBe(0);
        expect(output.terminalNotProvenGoneDispatches).toEqual([
          { dispatchId: "dispatch-1", reason: "terminal is absent from the host listing" },
        ]);
      }
      expect(await readdir(join(f.root, "dispatches"))).toContain("dispatch-1");
      expect(JSON.parse(await readFile(f.metaPath, "utf8"))).toMatchObject({
        terminalState: "retained",
        terminalReason: "terminal is absent from the host listing",
      });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("reports unproven terminals in text under a separate kept heading", async () => {
    const f = await fixture({ dispatchId: "text-dispatch", childHost: "orca", runtime: "host", terminalId: "child-terminal" });
    try {
      const result = await executeOrchestratePrune([], env(f.root), unprovenHost());
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.value).toContain("kept: terminal not proven gone\nkept: text-dispatch (terminal is absent from the host listing)");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("dry-run classifies unproven terminals without changing metadata", async () => {
    const f = await fixture({ childHost: "orca", runtime: "host", terminalId: "child-terminal" });
    try {
      const before = await readFile(f.metaPath);
      const result = await executeOrchestratePrune(["--dry-run", "--json"], env(f.root), unprovenHost());

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const output = JSON.parse(result.value) as Record<string, unknown>;
        expect(output.archived).toBe(0);
        expect(output.terminalNotProvenGoneDispatches).toEqual([
          { dispatchId: "dispatch-1", reason: "terminal is absent from the host listing" },
        ]);
      }
      expect(await readFile(f.metaPath)).toEqual(before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("prunes when Orca close explicitly reports a stale terminal handle", async () => {
    const f = await fixture({ childHost: "orca", runtime: "host", terminalId: "stale-terminal" });
    try {
      const process = fakeProcess((command, args) => command === "orca" && args[0] === "terminal" && args[1] === "list"
        ? ok({ stdout: "[]", stderr: "", exitCode: 0 })
        : failed("orca exited with status 1", 1, '{"code":"terminal_handle_stale","message":"terminal_handle_stale"}'));
      const result = await executeOrchestratePrune(["--json"], env(f.root), process);

      expect(result.kind).toBe("ok");
      let archivePath = "";
      if (result.kind === "ok") {
        const output = JSON.parse(result.value) as { archived: number; archivedDispatches: Array<{ path: string }> };
        expect(output.archived).toBe(1);
        archivePath = output.archivedDispatches[0]?.path ?? "";
      }
      expect(await readdir(join(f.root, "dispatches"))).not.toContain("dispatch-1");
      expect(archivePath).not.toBe("");
      expect(await readFile(join(archivePath, "meta.json"), "utf8")).toContain("stale-terminal");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  test("follows close for missing tmux sessions and panes", async () => {
    const missingSession = await fixture({ dispatchId: "missing-session", runtime: "tmux", tmuxSession: "gone-session", tmuxPane: "%1" });
    const missingPane = await fixture({ dispatchId: "missing-pane", runtime: "tmux", tmuxSession: "live-session", tmuxPane: "%2" });
    try {
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "has-session" && args.includes("gone-session")) return failed("can't find session", 1);
        if (command === "tmux" && args[0] === "has-session") return ok({ stdout: "", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%1\n", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      for (const f of [missingSession, missingPane]) {
        const result = await executeOrchestratePrune(["--json"], env(f.root), process);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") expect((JSON.parse(result.value) as Record<string, unknown>).archived).toBe(1);
      }
      expect(await readdir(join(missingSession.root, "dispatches"))).not.toContain("missing-session");
      expect(await readdir(join(missingPane.root, "dispatches"))).not.toContain("missing-pane");
    } finally {
      await Promise.all([missingSession.root, missingPane.root].map((root) => rm(root, { recursive: true, force: true })));
    }
  });
});
