import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { writeAdmissionPolicy } from "../../src/adapters/state/resources.js";
import { executeOrchestrateQueue } from "../../src/cli/commands/orchestrate-queue.js";
import { executeProc } from "../../src/core/proc-runner.js";

const adapter = createProcessAdapter();
const cleanups: Array<() => Promise<void>> = [];
// No machine has a tebibyte free, so this policy always queues.
const UNSATISFIABLE = { minAvailableMiB: 1024 * 1024 };

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function sandbox(): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(join(tmpdir(), "mb-proc-admission-"));
  const socket = join(root, "tmux.sock");
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MEGABRAIN_STATE_DIR: join(root, "state"),
    MEGABRAIN_TMUX_SOCKET: socket,
    MEGABRAIN_WORKTREE: root,
    CLAUDE_CODE_SESSION_ID: "proc-owner",
  };
  cleanups.push(async () => {
    // Stopping kills the process tree; killing the tmux server alone would orphan the command.
    await executeProc(["stop", "web", "--force"], environment, adapter);
    await adapter.run("tmux", ["-S", socket, "kill-server"]);
    await rm(root, { recursive: true, force: true });
  });
  return environment;
}

type Item = { id: string; kind: string; state: string; text: string };

async function procItems(env: Record<string, string | undefined>): Promise<Item[]> {
  const listed = await executeOrchestrateQueue(["--json"], env, adapter);
  if (listed.kind !== "ok") throw new Error(listed.error);
  return (JSON.parse(listed.value) as Item[]).filter((item) => item.kind === "proc");
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out");
}

async function sessionExists(env: Record<string, string | undefined>): Promise<boolean> {
  const listed = await executeProc(["list", "--json"], env, adapter);
  return listed.kind === "ok" && (JSON.parse(listed.value) as Array<{ state: string }>).some((row) => row.state === "running");
}

describe("process admission", () => {
  test("refuses with the reason when asked not to wait", async () => {
    const env = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const start = await executeProc(["start", "--name", "web", "--admission", "fail", "--", "sleep", "300"], env, adapter);
    expect(start.kind).toBe("failed");
    expect(start.kind === "failed" ? start.error : "").toContain("MiB");
    expect(await sessionExists(env)).toBe(false);
    expect(await procItems(env)).toHaveLength(0);
  }, 20000);

  test("waits in the shared queue and starts once the machine admits it", async () => {
    const env = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const pending = executeProc(["start", "--name", "web", "--", "sleep", "300"], env, adapter);
    const item = await waitFor(async () => (await procItems(env))[0]);
    expect(item.state).toBe("queued");
    expect(item.text).toContain("MiB");
    expect(await sessionExists(env)).toBe(false);
    await writeAdmissionPolicy(env, undefined);
    const start = await pending;
    expect(start.kind).toBe("ok");
    expect(await sessionExists(env)).toBe(true);
    expect(await procItems(env)).toHaveLength(0);
    await executeProc(["stop", "web"], env, adapter);
  }, 30000);

  test("the owner cancels a waiting start and it never runs", async () => {
    const env = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const pending = executeProc(["start", "--name", "web", "--", "sleep", "300"], env, adapter);
    const item = await waitFor(async () => (await procItems(env))[0]);
    const foreign = await executeOrchestrateQueue(["cancel", item.id], { ...env, CLAUDE_CODE_SESSION_ID: "someone-else" }, adapter);
    expect(foreign.kind).toBe("failed");
    const cancelled = await executeOrchestrateQueue(["cancel", item.id, "--reason", "not needed"], env, adapter);
    expect(cancelled.kind).toBe("ok");
    const start = await pending;
    expect(start.kind).toBe("failed");
    expect(start.kind === "failed" ? start.error : "").toContain("not needed");
    expect(await sessionExists(env)).toBe(false);
    expect(await procItems(env)).toHaveLength(0);
  }, 30000);

  test("a waiter that dies leaves no queue entry behind", async () => {
    const env = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const moduleUrl = new URL("../../src/core/proc-runner.ts", import.meta.url).href;
    const adapterUrl = new URL("../../src/adapters/proc.ts", import.meta.url).href;
    const script = `const { executeProc } = await import(${JSON.stringify(moduleUrl)}); const { createProcessAdapter } = await import(${JSON.stringify(adapterUrl)}); await executeProc(["start", "--name", "web", "--", "sleep", "300"], process.env, createProcessAdapter());`;
    const child = spawn(process.execPath, ["-e", script], { env: env as NodeJS.ProcessEnv, stdio: "ignore" });
    cleanups.push(async () => { child.kill("SIGKILL"); });
    await waitFor(async () => (await procItems(env))[0]);
    child.kill("SIGKILL");
    await waitFor(async () => ((await procItems(env)).length === 0 ? true : undefined));
    expect(await sessionExists(env)).toBe(false);
  }, 30000);
});
