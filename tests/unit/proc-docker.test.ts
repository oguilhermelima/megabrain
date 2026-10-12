import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { writeAdmissionPolicy } from "../../src/adapters/state/resources.js";
import { executeProc } from "../../src/core/proc-runner.js";

const adapter = createProcessAdapter();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// Fake docker and orb on PATH: docker answers info only while "up" exists, and orb logs every
// call and flips "up". The real OrbStack is never touched.
async function sandbox(): Promise<{ env: Record<string, string | undefined>; fake: string }> {
  const root = await mkdtemp(join(tmpdir(), "mb-proc-docker-"));
  const fake = join(root, "fake");
  const bin = join(fake, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = info ]; then [ -f '${fake}/up' ]; exit $?; fi\nexit 0\n`);
  await writeFile(join(bin, "orb"), `#!/bin/sh\necho "$1" >> '${fake}/orb.log'\ncase "$1" in start) touch '${fake}/up' ;; stop) rm -f '${fake}/up' ;; esac\n`);
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "orb"), 0o755);
  const socket = join(root, "tmux.sock");
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME,
    MEGABRAIN_STATE_DIR: join(root, "state"),
    MEGABRAIN_TMUX_SOCKET: socket,
    MEGABRAIN_WORKTREE: root,
    MEGABRAIN_DOCKER_IDLE_SECONDS: "1",
    CLAUDE_CODE_SESSION_ID: "docker-owner",
  };
  cleanups.push(async () => {
    await executeProc(["stop", "hold", "--force"], env, adapter);
    await adapter.run("tmux", ["-S", socket, "kill-server"]);
    const reaper = await readFile(join(root, "state", "procs", "docker-reaper.pid"), "utf8").catch(() => "");
    if (/^\d+$/.test(reaper.trim())) await adapter.run("kill", [reaper.trim()]);
    await rm(root, { recursive: true, force: true });
  });
  return { env, fake };
}

async function orbCalls(fake: string): Promise<string[]> {
  return (await readFile(join(fake, "orb.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("proc run", () => {
  test("returns the command's exit code and passes its arguments through", async () => {
    const { env, fake } = await sandbox();
    const marker = join(fake, "args");
    const result = await executeProc(["run", "--name", "once", "--", "sh", "-c", `printf '%s|' "$@" > '${marker}'; exit 7`, "sh", "--flag=a b", "--force"], env, adapter);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.exitCode : undefined).toBe(7);
    expect(await readFile(marker, "utf8")).toBe("--flag=a b|--force|");
  }, 20000);
});

describe("docker held by megabrain processes", () => {
  test("starts OrbStack for a process that needs docker and stops it once idle", async () => {
    const { env, fake } = await sandbox();
    const result = await executeProc(["run", "--name", "once", "--needs", "docker", "--", "docker", "info"], env, adapter);
    expect(result.kind === "ok" ? result.exitCode ?? 0 : -1).toBe(0);
    expect(await orbCalls(fake)).toEqual(["start"]);
    expect(await eventually(async () => (await orbCalls(fake)).includes("stop"))).toBe(true);
    expect(await orbCalls(fake)).toEqual(["start", "stop"]);
  }, 30000);

  test("never stops docker that was already running", async () => {
    const { env, fake } = await sandbox();
    await writeFile(join(fake, "up"), "");
    expect((await executeProc(["run", "--name", "once", "--needs", "docker", "--", "true"], env, adapter)).kind).toBe("ok");
    await pause(3000);
    expect(await orbCalls(fake)).toEqual([]);
    expect(existsSync(join(fake, "up"))).toBe(true);
  }, 30000);

  test("keeps docker up while another holder is alive", async () => {
    const { env, fake } = await sandbox();
    expect((await executeProc(["start", "--name", "hold", "--needs", "docker", "--", "sleep", "300"], env, adapter)).kind).toBe("ok");
    expect((await executeProc(["run", "--name", "once", "--needs", "docker", "--", "true"], env, adapter)).kind).toBe("ok");
    await pause(3000);
    expect(await orbCalls(fake)).toEqual(["start"]);
    expect((await executeProc(["stop", "hold"], env, adapter)).kind).toBe("ok");
    expect(await eventually(async () => (await orbCalls(fake)).includes("stop"))).toBe(true);
    expect(await orbCalls(fake)).toEqual(["start", "stop"]);
  }, 40000);
});

describe("container suite slots", () => {
  test("a second suite waits for the slot when the policy allows one", async () => {
    const { env } = await sandbox();
    await writeAdmissionPolicy(env, { maxContainerSuites: 1 });
    const first = executeProc(["run", "--name", "suite-a", "--slot", "container-suite", "--", "sleep", "3"], env, adapter);
    await pause(1000);
    const refused = await executeProc(["run", "--name", "suite-b", "--slot", "container-suite", "--admission", "fail", "--", "true"], env, adapter);
    expect(refused.kind).toBe("failed");
    expect(refused.kind === "failed" ? refused.error : "").toContain("container suites running");
    const other = await executeProc(["run", "--name", "plain", "--admission", "fail", "--", "true"], env, adapter);
    expect(other.kind).toBe("ok");
    expect((await first).kind).toBe("ok");
    const after = await executeProc(["run", "--name", "suite-b", "--slot", "container-suite", "--admission", "fail", "--", "true"], env, adapter);
    expect(after.kind).toBe("ok");
  }, 30000);

  test("suites are not limited without a policy", async () => {
    const { env } = await sandbox();
    const first = executeProc(["run", "--name", "suite-a", "--slot", "container-suite", "--", "sleep", "2"], env, adapter);
    await pause(500);
    const second = await executeProc(["run", "--name", "suite-b", "--slot", "container-suite", "--admission", "fail", "--", "true"], env, adapter);
    expect(second.kind).toBe("ok");
    await first;
  }, 30000);
});
