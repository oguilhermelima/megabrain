import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok } from "../../src/core/result.js";
import { recordAgentUpdate, type AgentUpdateReport } from "../../src/core/agent-update.js";
import { cleanupRun, appendReceived, existingWorktree, type SpawnRun, runComposerSpawn } from "./spawn-harness.js";

const runs: SpawnRun[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (runs.length > 0) await cleanupRun(runs.pop() as SpawnRun);
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

const now = Date.parse("2026-10-17T12:00:00.000Z");
const report = (checkedAt: number): AgentUpdateReport => ({
  agent: "codex", installed: "1.0.0", latest: "1.0.0", installKind: "npm", status: "up-to-date",
  checkedAt: new Date(checkedAt).toISOString(),
});

async function launchWithCachedResult(root: string, ageMs: number, settings?: { enabled: boolean; perAgent: Record<string, boolean> }): Promise<number> {
  await recordAgentUpdate(report(now - ageMs), { MEGABRAIN_STATE_DIR: root });
  if (settings !== undefined) await writeFile(join(root, "agent-update-settings.json"), JSON.stringify(settings));
  let requests = 0;
  const dispatchId = `dispatch-auto-update-${ageMs}-${settings?.enabled ?? "default"}`;
  const run = await runComposerSpawn(
    dispatchId,
    { agent: "codex", onSubmit: (_prompt, _dispatchRoot) => appendReceived(root, dispatchId) },
    { MEGABRAIN_STATE_DIR: root },
    ["--json"],
    undefined,
    {
      agentUpdates: { now: () => now, startAgentUpdate: async () => { requests += 1; } },
      resolveWorktree: async () => ok({ ...existingWorktree, path: `/work/tree-${ageMs}` }),
    },
  );
  runs.push(run);
  if (run.result.kind !== "ok") throw new Error(run.result.error);
  return requests;
}

describe("spawn agent auto-update scheduling", () => {
  test("uses the real six-hour cache window with auto-update enabled by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-spawn-agent-update-"));
    roots.push(root);
    expect(await launchWithCachedResult(root, 60 * 60 * 1000)).toBe(0);
    expect(await launchWithCachedResult(root, 7 * 60 * 60 * 1000)).toBe(1);
  });

  test("does not ask the updater when auto-update is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-spawn-agent-update-"));
    roots.push(root);
    expect(await launchWithCachedResult(root, 7 * 60 * 60 * 1000, { enabled: false, perAgent: {} })).toBe(0);
  });
});
