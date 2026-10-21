import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selfInvocation } from "../core/self-invocation.js";
import { scrubAgentEnvironment } from "../core/agent-env.js";

function socketDirectory(): string {
  // TMPDIR can differ between a command and its detached owner (for example when a
  // caller starts megabrain with env -i). Keep the hashed socket path discoverable
  // across those environments, while isolating it by uid under the system temp root.
  return join("/tmp", `mb-owner-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

export function ensureStateOwnerSocketDirectory(): string {
  const directory = socketDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error(`state owner socket directory is not a private directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
  return directory;
}

export function stateOwnerSocket(stateDir: string): string {
  return join(socketDirectory(), `s-${createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 24)}`);
}

export function legacyStateOwnerSocket(stateDir: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `mb-owner-${uid}`, `s-${createHash("sha256").update(resolve(stateDir)).digest("hex").slice(0, 24)}`);
}

function ownerPidPath(stateDir: string): string {
  return join(stateDir, "state-owner", "owner.pid");
}

export function processStartIdentity(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() || undefined : undefined;
}

export function processIdentityMatches(pid: number, expectedStart: string): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && expectedStart !== "" && processStartIdentity(pid) === expectedStart;
}

export function processStartTime(pid: number): number | undefined {
  const identity = processStartIdentity(pid);
  if (identity === undefined) return undefined;
  const timestamp = Date.parse(identity);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function ownerIsAliveAtSocket(stateDir: string, socket: string): boolean {
  if (!existsSync(socket)) return false;
  try {
    const pid = Number(readFileSync(ownerPidPath(stateDir), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export function legacyStateOwnerIsAlive(stateDir: string): boolean {
  const legacySocket = legacyStateOwnerSocket(stateDir);
  return legacySocket !== stateOwnerSocket(stateDir) && ownerIsAliveAtSocket(stateDir, legacySocket);
}

export function ownerStateSocketCandidates(stateDir: string): readonly string[] {
  const currentSocket = stateOwnerSocket(stateDir);
  const legacySocket = legacyStateOwnerSocket(stateDir);
  let pid: number;
  try { pid = Number(readFileSync(ownerPidPath(stateDir), "utf8").trim()); }
  catch { return []; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  try { process.kill(pid, 0); } catch { return []; }
  return [currentSocket, legacySocket].filter((socket, index, all) => all.indexOf(socket) === index && existsSync(socket));
}

export function ownerStateSocketForClient(stateDir: string): string {
  return ownerStateSocketCandidates(stateDir)[0] ?? stateOwnerSocket(stateDir);
}

function ownerIsAlive(stateDir: string): boolean {
  return ownerStateSocketCandidates(stateDir).length > 0;
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Starts the owner detached when a first read finds no database, and waits for its socket. */
export function ensureStateOwnerForRead(stateDir: string, environment: Readonly<Record<string, string | undefined>>): void {
  if (ownerIsAlive(stateDir)) return;
  const socketDir = ensureStateOwnerSocketDirectory();
  const builtEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../.build/megabrain");
  const testRunner = process.argv[1]?.endsWith(".test.ts") === true;
  const invocation = testRunner && existsSync(builtEntry)
    ? { command: builtEntry, args: ["__state-owner"] }
    : selfInvocation(process.execPath, process.argv, ["__state-owner"]);
  const ownerSource = process.argv[1] !== undefined && !process.argv[1].startsWith("/$bunfs/") ? resolve(process.argv[1]) : process.execPath;
  const ownerExecutable = testRunner && existsSync(builtEntry) ? builtEntry : ownerSource;
  const base = scrubAgentEnvironment({ ...process.env, ...environment });
  const testMode = testRunner || base.MEGABRAIN_STATE_OWNER_TEST_REGISTRY !== undefined;
  const ownerEnvironment = {
    ...base,
    MEGABRAIN_STATE_DIR: stateDir,
    MEGABRAIN_STATE_OWNER_DIR: stateDir,
    MEGABRAIN_STATE_OWNER_EXECUTABLE: ownerExecutable,
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
