import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok } from "../../src/core/result.js";
import { getDispatch, listMessages, stateDatabase, writeAdmissionPolicy } from "../../src/adapters/state-db.js";
import { executeOrchestrateQueue } from "../../src/cli/commands/orchestrate-queue.js";
import { superviseOnce } from "../../src/cli/commands/supervise.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { cleanupRun, existingWorktree, runComposerSpawn } from "./spawn-harness.js";

async function queuedSpawn(dispatchId: string, policy: { maxAgents?: number; maxPressure?: "normal" | "elevated" }) {
  const root = await mkdtemp(join(tmpdir(), "megabrain-admission-flow-"));
  await writeAdmissionPolicy({ MEGABRAIN_STATE_DIR: root }, policy);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const vmStat = await readFile(join(import.meta.dir, "../fixtures/resources/macos/vm-stat.txt"), "utf8");
  const sysctl = await readFile(join(import.meta.dir, "../fixtures/resources/macos/sysctl.txt"), "utf8");
  const meminfo = await readFile(join(import.meta.dir, "../fixtures/resources/linux/meminfo.txt"), "utf8");
  const loadavg = await readFile(join(import.meta.dir, "../fixtures/resources/linux/loadavg.txt"), "utf8");
  let machineFreed = false;
  const run = await runComposerSpawn(dispatchId, { agent: "codex" }, { MEGABRAIN_STATE_DIR: root }, ["--worktree", repo, "--json"], (command, args) => {
    if (command === "cat" && args.includes("/proc/meminfo")) return ok({ stdout: meminfo, stderr: "", exitCode: 0 });
    if (command === "cat" && args.includes("/proc/loadavg")) return ok({ stdout: loadavg, stderr: "", exitCode: 0 });
    if (command === "cat" && args.includes("/proc/pressure/memory")) return ok({ stdout: machineFreed ? "some avg10=0.1 avg60=0.1 avg300=0.1 total=1\n" : "some avg10=2.0 avg60=2.0 avg300=2.0 total=1\n", stderr: "", exitCode: 0 });
    if (command === "getconf") return ok({ stdout: "8\n", stderr: "", exitCode: 0 });
    if (command === "vm_stat") return ok({ stdout: vmStat, stderr: "", exitCode: 0 });
    if (command === "sysctl") return ok({ stdout: machineFreed ? sysctl.replace(/kern\.memorystatus_vm_pressure_level:\s*\d+/, "kern.memorystatus_vm_pressure_level: 1") : sysctl.replace(/kern\.memorystatus_vm_pressure_level:\s*\d+/, "kern.memorystatus_vm_pressure_level: 2"), stderr: "", exitCode: 0 });
    if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: `${repo}\n`, stderr: "", exitCode: 0 });
    if (command === "git" && args.includes("--short") && args.includes("HEAD")) return ok({ stdout: "feat/admission-flow\n", stderr: "", exitCode: 0 });
    return ok({ stdout: "", stderr: "", exitCode: 0 });
  }, { resolveWorktree: async () => ok({ ...existingWorktree, path: repo, branch: "feat/admission-flow" }) });
  return { root, repo, run, freeMachine: () => { machineFreed = true; }, environment: {
    MEGABRAIN_STATE_DIR: root, MEGABRAIN_SESSION_ID: "parent-terminal", MEGABRAIN_SESSION_HOST: "tmux",
    MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS: "300", MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS: "300",
  } };
}

describe("admission queue flow", () => {
  test("queues without creating a terminal and lets the parent cancel the recorded spawn", async () => {
    const context = await queuedSpawn("admission-flow-cancel", { maxAgents: 0 });
    try {
      if (context.run.result.kind === "failed") throw new Error(context.run.result.error);
      if (context.run.result.kind === "unknown") throw new Error(context.run.result.reason);
      expect(context.run.result.kind).toBe("ok");
      expect(context.run.result.kind === "ok" ? JSON.parse(context.run.result.value).status : "").toBe("queued");
      expect(context.run.process.calls.some(({ command, args }) => command === "tmux" && ["new-session", "split-window"].includes(args[0] ?? ""))).toBe(false);
      const database = stateDatabase({ MEGABRAIN_STATE_DIR: context.root });
      if (database.kind !== "ok") throw new Error(database.error);
      expect(getDispatch(database.value, context.run.dispatchId).kind === "ok" ? getDispatch(database.value, context.run.dispatchId).value?.state : "").toBe("queued");
      const listed = await executeOrchestrateQueue([], context.environment, context.run.process);
      expect(listed.kind === "ok" ? listed.value : "").toContain("spawn\t");
      const cancelled = await executeOrchestrateQueue(["cancel", context.run.dispatchId], context.environment, context.run.process);
      expect(cancelled.kind === "ok" ? cancelled.value : "").toContain("cancelled:");
      expect(getDispatch(database.value, context.run.dispatchId).kind === "ok" ? getDispatch(database.value, context.run.dispatchId).value?.state : "").toBe("closed");
    } finally {
      await cleanupRun(context.run);
      await rm(context.root, { recursive: true, force: true });
    }
  });

  test("starts the same queued dispatch when admission opens and records one notice for each transition", async () => {
    const context = await queuedSpawn("admission-flow-start", { maxPressure: "normal" });
    const original = getTmux();
    registerTmux({
      ...original, id: "tmux", paneExists: async () => ok(true), sessionExists: async () => ok(true), panesForSession: async () => ok(["%9"]),
      capturePane: context.run.pane.provider.capturePane, sendText: context.run.pane.provider.sendText,
      pasteText: context.run.pane.provider.pasteText, sendKey: context.run.pane.provider.sendKey,
    } as typeof original);
    try {
      if (context.run.result.kind === "failed") throw new Error(context.run.result.error);
      if (context.run.result.kind === "unknown") throw new Error(context.run.result.reason);
      context.freeMachine();
      const database = stateDatabase({ MEGABRAIN_STATE_DIR: context.root });
      if (database.kind !== "ok") throw new Error(database.error);
      const outcome = await superviseOnce(context.root, database.value, context.environment, context.run.process, Date.now());
      expect(outcome.open).toBe(true);
      const started = getDispatch(database.value, context.run.dispatchId);
      expect(started.kind === "ok" ? started.value?.dispatchId : "").toBe(context.run.dispatchId);
      expect(started.kind === "ok" ? started.value?.state : "").toBe("running");
      const messages = listMessages(database.value, context.run.dispatchId);
      expect(messages.kind === "ok" ? messages.value.filter((item) => item.type === "admission").map((item) => item.text) : []).toEqual([
        expect.stringContaining("queued at position 1"), expect.stringContaining("queued spawn started"),
      ]);
    } finally {
      registerTmux(original);
      await cleanupRun(context.run);
      await rm(context.root, { recursive: true, force: true });
    }
  });

  test("--admission fail refuses without creating a terminal", async () => {
    const context = await queuedSpawn("admission-flow-fail", { maxAgents: 0 });
    try {
      const result = await import("../../src/cli/commands/orchestrate-spawn.js").then(({ executeSpawn }) => executeSpawn(
        ["--worktree", context.repo, "--agent", "codex", "--prompt", "do the task", "--tmux", "true", "--admission", "fail"],
        context.environment, context.run.process, { resolveWorktree: async () => ok({ ...existingWorktree, path: context.repo }) },
      ));
      expect(result.kind).toBe("failed");
      expect(context.run.process.calls.some(({ command, args }) => command === "tmux" && ["new-session", "split-window"].includes(args[0] ?? ""))).toBe(false);
    } finally {
      await cleanupRun(context.run);
      await rm(context.root, { recursive: true, force: true });
    }
  });
});
