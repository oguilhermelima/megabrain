import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const startedOwnerPids = new Set<number>();

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause: unknown) { return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH"); }
}

function commandFor(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() : "";
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (running(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !running(pid);
}

export function trackStateOwnerCleanup(stateDirectory: string): void {
  const pidPath = join(stateDirectory, "state-owner", "owner.pid");
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (Number.isSafeInteger(pid) && pid > 0) startedOwnerPids.add(pid);
}

export async function cleanupTrackedStateOwners(stateDirectories: Iterable<string>, ownerPids: Iterable<number> = []): Promise<void> {
  for (const stateDirectory of stateDirectories) {
    const candidate = resolve(stateDirectory);
    const temporaryRoot = resolve(tmpdir());
    if (!candidate.startsWith(`${temporaryRoot}/`) && !candidate.startsWith("/tmp/") && !candidate.startsWith("/private/tmp/") && !candidate.startsWith("/private/var/folders/")) {
      throw new Error(`refusing to clean non-temporary state directory: ${candidate}`);
    }
    trackStateOwnerCleanup(stateDirectory);
    rmSync(stateDirectory, { recursive: true, force: true });
  }

  for (const pid of ownerPids) {
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) startedOwnerPids.add(pid);
  }

  for (const pid of startedOwnerPids) {
    if (await waitForExit(pid, 2_500)) continue;
    const command = commandFor(pid);
    if (!command.includes("__state-owner")) throw new Error(`refusing to signal unverified state owner pid ${pid}: ${command || "process is not visible"}`);
    try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
    if (await waitForExit(pid, 1_000)) continue;
    if (!commandFor(pid).includes("__state-owner")) throw new Error(`state owner pid ${pid} changed before forced cleanup`);
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    if (!await waitForExit(pid, 1_000)) throw new Error(`state owner pid ${pid} survived test cleanup`);
  }
  startedOwnerPids.clear();
}
