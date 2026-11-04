import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stateOwnerSocket } from "../../src/db/state-owner.js";

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launchOwner(leakHandle: boolean): { child: ChildProcess; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mb-owner-exit-"));
  roots.push(root);
  const modulePath = resolve(import.meta.dir, "../../src/cli/router.ts");
  const script = [
    'import { createProcessAdapter } from "./src/adapters/proc.ts";',
    'import { route } from "./src/cli/router.ts";',
    `process.argv = [process.execPath, "/$bunfs/root/megabrain-cli", "__state-owner"];`,
    ...(leakHandle ? ["setInterval(() => {}, 1_000);"] : []),
    'await route(["__state-owner"], { environment: process.env, processAdapter: createProcessAdapter() });',
  ].join("\n");
  const child = spawn(process.execPath, ["--eval", script], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, MEGABRAIN_STATE_DIR: root, MEGABRAIN_STATE_OWNER_DIR: root, MEGABRAIN_STATE_OWNER_IDLE_MS: "100" },
    stdio: "ignore",
  });
  children.push(child);
  return { child, root };
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolveExit(true); });
  });
}

async function waitForReady(root: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(join(root, "logs", "state-owner.log"), "utf8").includes('"event":"ready"')) return;
    } catch { /* owner is still starting */ }
    await new Promise((resolveReady) => setTimeout(resolveReady, 20));
  }
  throw new Error("state owner did not become ready in time");
}

describe("state owner process exit", () => {
  test("exits after the owner logs stopped, even with a leaked handle", async () => {
    const { child, root } = launchOwner(true);
    const exited = await waitForExit(child, 3_000);
    const log = readFileSync(join(root, "logs", "state-owner.log"), "utf8");
    expect(log).toContain('"event":"stopped"');
    expect(exited).toBe(true);
  });

  test("exits after idle stop without a signal", async () => {
    const { child, root } = launchOwner(false);
    const exited = await waitForExit(child, 3_000);
    const log = readFileSync(join(root, "logs", "state-owner.log"), "utf8");
    expect(log).toContain('"event":"stopped"');
    expect(exited).toBe(true);
  });

  test("exits when its state directory is removed", async () => {
    const { child, root } = launchOwner(false);
    await waitForReady(root, 3_000);
    rmSync(root, { recursive: true, force: true });

    expect(await waitForExit(child, 3_000)).toBe(true);
    expect(readFileSync(join(root, "logs", "state-owner.log"), "utf8")).toContain('"event":"stopped"');
  });

  test("exits when its socket is removed", async () => {
    const { child, root } = launchOwner(false);
    await waitForReady(root, 3_000);
    rmSync(stateOwnerSocket(root), { force: true });

    expect(await waitForExit(child, 3_000)).toBe(true);
    expect(readFileSync(join(root, "logs", "state-owner.log"), "utf8")).toContain('"event":"stopped"');
  });

  test("test cleanup waits for a registered owner to finish stopping", async () => {
    const registry = process.env.MEGABRAIN_STATE_OWNER_TEST_REGISTRY;
    if (registry === undefined) throw new Error("state owner test registry is not configured");
    const root = mkdtempSync(join(tmpdir(), "mb-owner-registry-"));
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); process.stdout.write('ready'); setInterval(() => {}, 1000);", "__state-owner"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolve());
    });
    if (child.pid === undefined) throw new Error("test owner did not receive a pid");
    mkdirSync(join(root, "state-owner"), { recursive: true });
    writeFileSync(join(root, "state-owner", "owner.pid"), `${child.pid}\n`);
    appendFileSync(registry, `${JSON.stringify({ pid: child.pid, stateDir: root })}\n`);
  });
});
