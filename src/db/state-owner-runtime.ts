import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selfInvocation } from "../core/self-invocation.js";
import { scrubAgentEnvironment } from "../core/agent-env.js";

function socketDirectory(): string {
  return join(tmpdir(), `mb-owner-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

export function stateOwnerSocket(stateDir: string): string {
  return join(socketDirectory(), `s-${createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 24)}`);
}

function ownerPidPath(stateDir: string): string {
  return join(stateDir, "state-owner", "owner.pid");
}

export function processStartIdentity(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() || undefined : undefined;
}

export function processStartTime(pid: number): number | undefined {
  const identity = processStartIdentity(pid);
  if (identity === undefined) return undefined;
  const timestamp = Date.parse(identity);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function ownerIsAlive(stateDir: string): boolean {
  if (!existsSync(stateOwnerSocket(stateDir))) return false;
  try {
    const pid = Number(readFileSync(ownerPidPath(stateDir), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Starts the owner detached when a first read finds no database, and waits for its socket. */
export function ensureStateOwnerForRead(stateDir: string, environment: Readonly<Record<string, string | undefined>>): void {
  if (ownerIsAlive(stateDir)) return;
  const socketDir = socketDirectory();
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const builtEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../.build/megabrain");
  const testRunner = process.argv[1]?.endsWith(".test.ts") === true;
  const invocation = testRunner && existsSync(builtEntry)
    ? { command: builtEntry, args: ["__state-owner"] }
    : selfInvocation(process.execPath, process.argv, ["__state-owner"]);
  const base = scrubAgentEnvironment({ ...process.env, ...environment });
  const testMode = testRunner || base.MEGABRAIN_STATE_OWNER_TEST_REGISTRY !== undefined;
  const ownerEnvironment = {
    ...base,
    MEGABRAIN_STATE_DIR: stateDir,
    MEGABRAIN_STATE_OWNER_DIR: stateDir,
    ...(testMode ? {
      MEGABRAIN_STATE_OWNER_TEST_MODE: "1",
      MEGABRAIN_STATE_OWNER_TEST_PARENT_PID: String(testRunner ? process.pid : process.ppid),
      MEGABRAIN_STATE_OWNER_TEST_PARENT_START: processStartIdentity(testRunner ? process.pid : process.ppid) ?? "",
    } : {}),
    ...(base.MEGABRAIN_STATE_OWNER_IDLE_MS === undefined && resolve(stateDir).startsWith(`${resolve(tmpdir())}/`) ? { MEGABRAIN_STATE_OWNER_IDLE_MS: testMode ? "2000" : "30000" } : {}),
  };
  const child = spawn(invocation.command, invocation.args, { detached: true, stdio: "ignore", env: ownerEnvironment });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (ownerIsAlive(stateDir)) return;
    if (child.pid !== undefined) {
      try { process.kill(child.pid, 0); }
      catch { throw new Error(`state owner could not start from a first read (pid ${child.pid} exited)`); }
    }
    wait(20);
  }
  throw new Error(`state owner did not start within 10 seconds for ${stateDir}`);
}
