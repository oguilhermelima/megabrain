import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { writeAdmissionPolicy } from "../../src/adapters/state/resources.js";
import { executeOrchestrateQueue } from "../../src/cli/commands/orchestrate-queue.js";
import { executeRepository } from "../../src/cli/commands/repository.js";
import { executeProc } from "../../src/core/proc-runner.js";

const adapter = createProcessAdapter();
const cleanups: Array<() => Promise<void>> = [];
const UNSATISFIABLE = { minAvailableMiB: 1024 * 1024 };

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Sandbox = { env: Record<string, string | undefined>; repo: string };

async function sandbox(runCommand: string | null = "sleep 300"): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "mb-repo-run-"));
  const server = `mb-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = join(root, "project");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    MEGABRAIN_STATE_DIR: join(root, "state"),
    MEGABRAIN_TMUX_SERVER: server,
    CLAUDE_CODE_SESSION_ID: "repo-run-owner",
  };
  await adapter.run("git", ["init", "-q", repo]);
  if (runCommand !== null) {
    const saved = await executeRepository(["scripts", repo, "--run", runCommand, "--json"], env, adapter);
    if (saved.kind !== "ok") throw new Error(saved.error);
  }
  cleanups.push(async () => {
    await executeRepository(["stop", repo, "--force"], env, adapter);
    await adapter.run("tmux", ["-L", server, "kill-server"]);
    await rm(root, { recursive: true, force: true });
  });
  return { env, repo };
}

type Row = { name: string; state: string; pid: number; worktree: string };

async function procRows(env: Record<string, string | undefined>): Promise<Row[]> {
  const listed = await executeProc(["list", "--json"], env, adapter);
  if (listed.kind !== "ok") throw new Error(listed.error);
  // The queue's entries live beside the records and carry no state.
  return (JSON.parse(listed.value) as Row[]).filter((row) => row.state !== undefined);
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

describe("repo run", () => {
  test("starts the script as one managed process in the worktree", async () => {
    const { env, repo } = await sandbox();
    const started = await executeRepository(["run", repo, "--json"], env, adapter);
    expect(started.kind).toBe("ok");
    const body = JSON.parse(started.kind === "ok" ? started.value : "{}") as { state: string; script: string; alreadyRunning: boolean; pid: number };
    expect(body).toMatchObject({ state: "running", script: "run", alreadyRunning: false });
    const rows = await procRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "repo-run", state: "running" });
    expect(rows[0]?.pid).toBe(body.pid);
  }, 30000);

  test("streams early ANSI output to the run pane and keeps it in proc.log", async () => {
    const { env, repo } = await sandbox("printf '\033[32mEARLY_RUN_OUTPUT\033[0m\\n'; sleep 300");
    const started = await executeRepository(["run", repo, "--json"], env, adapter);
    expect(started.kind).toBe("ok");
    const record = JSON.parse(started.kind === "ok" ? started.value : "{}") as { session: string };
    const pane = async () => await adapter.run("tmux", ["-L", env.MEGABRAIN_TMUX_SERVER!, "capture-pane", "-p", "-e", "-t", record.session]);
    expect(await waitFor(async () => {
      const captured = await pane();
      return captured.kind === "ok" && captured.value.stdout.includes("EARLY_RUN_OUTPUT") ? true : undefined;
    })).toBe(true);
    const captured = await pane();
    expect(captured.kind === "ok" ? captured.value.stdout : "").toContain(`${String.fromCharCode(27)}[32m`);
    const logs = await executeProc(["logs", "repo-run", "--grep", "EARLY_RUN_OUTPUT"], { ...env, MEGABRAIN_WORKTREE: repo }, adapter);
    expect(logs.kind).toBe("ok");
    expect(logs.kind === "ok" ? logs.value : "").toContain("EARLY_RUN_OUTPUT");
  }, 30000);

  test("enables color for commands whose output is piped", async () => {
    const { env, repo } = await sandbox("if [ \"$FORCE_COLOR\" = 1 ]; then printf '\\033[35mFORCED_COLOR_OUTPUT\\033[0m\\n'; else printf 'NO_FORCED_COLOR\\n'; fi; sleep 300");
    const started = await executeRepository(["run", repo, "--json"], env, adapter);
    expect(started.kind).toBe("ok");
    const record = JSON.parse(started.kind === "ok" ? started.value : "{}") as { session: string };
    const pane = async () => await adapter.run("tmux", ["-L", env.MEGABRAIN_TMUX_SERVER!, "capture-pane", "-p", "-e", "-t", record.session]);
    expect(await waitFor(async () => {
      const captured = await pane();
      return captured.kind === "ok" && captured.value.stdout.includes("FORCED_COLOR_OUTPUT") ? true : undefined;
    })).toBe(true);
    const captured = await pane();
    expect(captured.kind === "ok" ? captured.value.stdout : "").toContain(`${String.fromCharCode(27)}[35m`);
  }, 30000);

  test("proc logs resolves a listed name without requiring its worktree selector", async () => {
    const { env, repo } = await sandbox("printf 'NAMED_PROC_LOG_OUTPUT\\n'; sleep 300");
    expect((await executeRepository(["run", repo, "--json"], env, adapter)).kind).toBe("ok");
    expect(await waitFor(async () => {
      const result = await executeProc(["logs", "repo-run", "--grep", "NAMED_PROC_LOG_OUTPUT"], { ...env, MEGABRAIN_WORKTREE: undefined }, adapter);
      return result.kind === "ok" && result.value.includes("NAMED_PROC_LOG_OUTPUT") ? true : undefined;
    })).toBe(true);
  }, 30000);

  test("a second run reports the running one instead of stacking", async () => {
    const { env, repo } = await sandbox();
    const first = await executeRepository(["run", repo, "--json"], env, adapter);
    const second = await executeRepository(["run", repo, "--json"], env, adapter);
    expect(second.kind).toBe("ok");
    const a = JSON.parse(first.kind === "ok" ? first.value : "{}") as { pid: number };
    const b = JSON.parse(second.kind === "ok" ? second.value : "{}") as { pid: number; alreadyRunning: boolean };
    expect(b.alreadyRunning).toBe(true);
    expect(b.pid).toBe(a.pid);
    expect(await procRows(env)).toHaveLength(1);
  }, 30000);

  test("refuses with the reason under fail admission", async () => {
    const { env, repo } = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const refused = await executeRepository(["run", repo, "--admission", "fail", "--json"], env, adapter);
    expect(refused.kind).toBe("failed");
    expect(refused.kind === "failed" ? refused.error : "").toContain("MiB");
    expect(await procRows(env)).toHaveLength(0);
  }, 30000);

  test("queues under wait admission and starts once admitted", async () => {
    const { env, repo } = await sandbox();
    await writeAdmissionPolicy(env, UNSATISFIABLE);
    const pending = executeRepository(["run", repo, "--admission", "wait", "--json"], env, adapter);
    const item = await waitFor(async () => {
      const listed = await executeOrchestrateQueue(["--json"], env, adapter);
      if (listed.kind !== "ok") return undefined;
      return (JSON.parse(listed.value) as Array<{ kind: string; state: string; text: string }>).find((entry) => entry.kind === "proc");
    });
    expect(item.state).toBe("queued");
    expect(await procRows(env)).toHaveLength(0);
    await writeAdmissionPolicy(env, undefined);
    expect((await pending).kind).toBe("ok");
    expect(await procRows(env)).toHaveLength(1);
  }, 30000);

  test("stop ends the process and the next run starts a fresh one", async () => {
    const { env, repo } = await sandbox();
    const first = await executeRepository(["run", repo, "--json"], env, adapter);
    const stopped = await executeRepository(["stop", repo], env, adapter);
    expect(stopped.kind === "failed" ? stopped.error : "").toBe("");
    expect((await procRows(env))[0]?.state).toBe("exited");
    const again = await executeRepository(["run", repo, "--json"], env, adapter);
    const a = JSON.parse(first.kind === "ok" ? first.value : "{}") as { pid: number };
    const b = JSON.parse(again.kind === "ok" ? again.value : "{}") as { pid: number; alreadyRunning: boolean };
    expect(b.alreadyRunning).toBe(false);
    expect(b.pid).not.toBe(a.pid);
  }, 30000);

  test("runs the named script in the given worktree under its own name", async () => {
    const { env, repo } = await sandbox();
    const saved = await executeRepository(["scripts", repo, "--build", "sleep 300", "--json"], env, adapter);
    expect(saved.kind).toBe("ok");
    const built = await executeRepository(["run", repo, "--script", "build", "--worktree", repo, "--json"], env, adapter);
    expect(built.kind).toBe("ok");
    expect((await procRows(env)).map((row) => row.name)).toEqual(["repo-build"]);
  }, 30000);

  test("fails plainly when the project has no command for the script", async () => {
    const { env, repo } = await sandbox(null);
    const result = await executeRepository(["run", repo, "--script", "install", "--json"], env, adapter);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("no install command");
    expect(await procRows(env)).toHaveLength(0);
  }, 30000);
});
