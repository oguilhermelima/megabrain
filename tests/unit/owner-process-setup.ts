import { afterAll, afterEach } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeriodicTestRunnerCollection } from "../helpers/test-runner-memory.js";
import { cleanupTrackedStateOwners } from "../helpers/state-owner-cleanup.js";

const manifestDirectory = mkdtempSync(join(tmpdir(), "megabrain-test-owners-"));
const manifest = join(manifestDirectory, "owners.txt");
appendFileSync(manifest, "");
process.env.MEGABRAIN_STATE_OWNER_TEST_REGISTRY = manifest;
afterEach(createPeriodicTestRunnerCollection(() => Bun.gc(true), 100));

afterAll(async () => {
  const entries = existsSync(manifest)
    ? readFileSync(manifest, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; stateDir: string })
    : [];
  await cleanupTrackedStateOwners(entries.map((entry) => entry.stateDir), entries.map((entry) => entry.pid));
  rmSync(manifestDirectory, { recursive: true, force: true });
});
