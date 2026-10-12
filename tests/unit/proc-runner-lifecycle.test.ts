import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { executeProc, isProcErrorLine } from "../../src/core/proc-runner.js";

const adapter = createProcessAdapter();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function sandbox(): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(join(tmpdir(), "mb-proc-"));
  const socket = join(root, "tmux.sock");
  cleanups.push(async () => {
    await adapter.run("tmux", ["-S", socket, "kill-server"]);
    await rm(root, { recursive: true, force: true });
  });
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MEGABRAIN_STATE_DIR: join(root, "state"),
    MEGABRAIN_TMUX_SOCKET: socket,
    MEGABRAIN_WORKTREE: root,
  };
}

async function alive(pid: number): Promise<boolean> {
  return (await adapter.run("kill", ["-0", String(pid)])).kind === "ok";
}

async function descendants(root: number): Promise<number[]> {
  const table = await adapter.run("ps", ["-A", "-o", "pid=,ppid="]);
  if (table.kind !== "ok") return [];
  const rows = table.value.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const tree = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, ppid] of rows) if (pid !== undefined && ppid !== undefined && tree.has(ppid) && !tree.has(pid)) { tree.add(pid); changed = true; }
  }
  tree.delete(root);
  return [...tree];
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function started(output: string): { pid: number } {
  return JSON.parse(output) as { pid: number };
}

describe("managed process lifecycle", () => {
  test("stop ends the whole process tree and the session", async () => {
    const env = await sandbox();
    const start = await executeProc(["start", "--name", "tree", "--json", "--shell", "sleep 300 & sleep 301 & wait"], env, adapter);
    expect(start.kind).toBe("ok");
    const pid = start.kind === "ok" ? started(start.value).pid : 0;
    expect(await waitFor(async () => (await descendants(pid)).length >= 3)).toBe(true);
    const children = await descendants(pid);
    const stop = await executeProc(["stop", "tree"], env, adapter);
    expect(stop.kind).toBe("ok");
    for (const child of [pid, ...children]) expect(await waitFor(async () => !(await alive(child)))).toBe(true);
  }, 20000);

  test("stopping right after start leaves no process behind", async () => {
    const env = await sandbox();
    const marker = `sleep ${40000 + (process.pid % 10000)}`;
    const leftovers = async (): Promise<string> => {
      const found = await adapter.run("pgrep", ["-f", `^${marker}$`]);
      return found.kind === "ok" ? found.value.stdout.trim() : "";
    };
    for (let round = 0; round < 5; round += 1) {
      expect((await executeProc(["start", "--name", "quick", "--", ...marker.split(" ")], env, adapter)).kind).toBe("ok");
      expect((await executeProc(["stop", "quick"], env, adapter)).kind).toBe("ok");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const found = await leftovers();
    if (found !== "") await adapter.run("kill", found.split(/\s+/));
    expect(found).toBe("");
  }, 60000);

  test("only the caller that started a process may stop it", async () => {
    const env = await sandbox();
    const start = await executeProc(["start", "--name", "owned", "--", "sleep", "300"], { ...env, CLAUDE_CODE_SESSION_ID: "owner-a" }, adapter);
    expect(start.kind).toBe("ok");
    const foreign = await executeProc(["stop", "owned"], { ...env, CLAUDE_CODE_SESSION_ID: "owner-b" }, adapter);
    expect(foreign.kind).toBe("failed");
    const own = await executeProc(["stop", "owned"], { ...env, CLAUDE_CODE_SESSION_ID: "owner-a" }, adapter);
    expect(own.kind).toBe("ok");
  }, 20000);

  test("a taken port is refused and its owner is named", async () => {
    const env = await sandbox();
    const server: Server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const start = await executeProc(["start", "--name", "web", "--port", String(port), "--", "sleep", "300"], env, adapter);
    expect(start.kind).toBe("failed");
    expect(start.kind === "failed" ? start.error : "").toContain(`pid ${process.pid}`);
  }, 20000);

  test("restart runs the same command again", async () => {
    const env = await sandbox();
    expect((await executeProc(["start", "--name", "again", "--shell", "echo run-$$; sleep 300"], env, adapter)).kind).toBe("ok");
    const firstRun = async (): Promise<string> => {
      const logs = await executeProc(["logs", "again", "--grep", "run-"], env, adapter);
      return logs.kind === "ok" ? logs.value : "";
    };
    expect(await waitFor(async () => (await firstRun()).includes("run-"))).toBe(true);
    expect((await executeProc(["restart", "again"], env, adapter)).kind).toBe("ok");
    expect(await waitFor(async () => (await firstRun()).trim().split("\n").length >= 2)).toBe(true);
    await executeProc(["stop", "again"], env, adapter);
  }, 30000);

  test("following logs prints each line once", async () => {
    const env = await sandbox();
    expect((await executeProc(["start", "--name", "short", "--shell", "echo one; echo two; sleep 1"], env, adapter)).kind).toBe("ok");
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let follow;
    try {
      follow = await executeProc(["logs", "short", "--follow"], env, adapter);
    } finally {
      process.stdout.write = write;
    }
    expect(follow.kind).toBe("ok");
    const printed = written.join("") + (follow.kind === "ok" ? follow.value : "");
    expect(printed.split("\n").filter((line) => line.endsWith(" one"))).toHaveLength(1);
  }, 20000);
});

describe("error lines", () => {
  test("a clean exit is not an error, a failing one is", () => {
    expect(isProcErrorLine("2026-10-12T10:00:00.000Z process exited with code 0")).toBe(false);
    expect(isProcErrorLine("2026-10-12T10:00:00.000Z process exited with code 1")).toBe(true);
  });
});
