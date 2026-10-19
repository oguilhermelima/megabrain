import { afterAll, afterEach, expect } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPeriodicTestRunnerCollection } from "../helpers/test-runner-memory.js";

const manifestDirectory = mkdtempSync(join(tmpdir(), "megabrain-test-owners-"));
const manifest = join(manifestDirectory, "owners.txt");
appendFileSync(manifest, "");
process.env.MEGABRAIN_STATE_OWNER_TEST_REGISTRY = manifest;
afterEach(createPeriodicTestRunnerCollection(() => Bun.gc(true), 100));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isOwner(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 && String(result.stdout).includes("__state-owner");
}

afterAll(async () => {
  const entries = existsSync(manifest)
    ? readFileSync(manifest, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; stateDir: string })
    : [];
  const pids = [...new Set(entries.map((entry) => entry.pid).filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && isOwner(pid)))];
  for (const { stateDir } of entries) {
    const candidate = resolve(stateDir);
    const temporaryRoot = resolve(tmpdir());
    if (!candidate.startsWith(`${temporaryRoot}/`) && !candidate.startsWith("/tmp/") && !candidate.startsWith("/private/tmp/") && !candidate.startsWith("/private/var/folders/")) {
      throw new Error(`refusing to clean non-temporary state directory: ${candidate}`);
    }
    rmSync(candidate, { recursive: true, force: true });
  }
  const deadline = Date.now() + 2_500;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const survivors = pids.filter(isAlive);
  for (const pid of survivors) {
    try { process.kill(pid, "SIGTERM"); } catch { /* owner exited between checks */ }
  }
  rmSync(manifestDirectory, { recursive: true, force: true });
  expect(survivors).toEqual([]);
});
