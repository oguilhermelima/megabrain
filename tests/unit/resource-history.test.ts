import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { stateDatabase } from "../../src/adapters/state-db.js";
import { estimateTypicalRssByAgent, recordResourceSamples } from "../../src/adapters/state/resources.js";
import { executeResources } from "../../src/cli/commands/resources.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const environment = async () => {
  const root = await mkdtemp(join(tmpdir(), "megabrain-resource-history-")); roots.push(root);
  return { root, env: { MEGABRAIN_STATE_DIR: root } };
};
const processAdapter: ProcessAdapter = {
  run: async () => ({ kind: "failed", error: "unused" }),
  startDetached: async () => ({ kind: "failed", error: "unused" }),
  invocationCount: () => 0,
};

describe("opt-in resource history", () => {
  test("does not write samples until enabled", async () => {
    const { env } = await environment();
    const database = stateDatabase(env);
    expect(database.kind).toBe("ok");
    if (database.kind !== "ok") return;
    const samples = [{ dispatchId: "dispatch-one", agent: "codex", rssBytes: 100, cpuPercent: 1 }];
    expect(recordResourceSamples(env, database.value, samples, 2_000_000_000_000)).toBe(0);
    expect(database.value.db.query<{ count: number }>("SELECT count(*) AS count FROM resource_samples").get()?.count).toBe(0);
  });

  test("records enabled samples, prunes history past 24 hours, and estimates typical RSS by agent", async () => {
    const { env } = await environment();
    expect((await executeResources(["enable"], env, processAdapter)).kind).toBe("ok");
    const database = stateDatabase(env);
    expect(database.kind).toBe("ok");
    if (database.kind !== "ok") return;
    const now = 2_000_000_000_000;
    database.value.db.run("INSERT INTO resource_samples (dispatch_id, agent, sampled_at, rss_bytes, cpu_percent) VALUES (?, ?, ?, ?, ?)", ["old", "codex", now - 86_400_001, 1_000_000, 1]);
    const count = recordResourceSamples(env, database.value, [
      { dispatchId: "dispatch-one", agent: "codex", rssBytes: 10_000_000, cpuPercent: 2 },
      { dispatchId: "dispatch-two", agent: "codex", rssBytes: 30_000_000, cpuPercent: 4 },
    ], now);
    expect(count).toBe(2);
    expect(database.value.db.query<{ count: number }>("SELECT count(*) AS count FROM resource_samples").get()?.count).toBe(2);
    expect(estimateTypicalRssByAgent(database.value, now)).toEqual({ codex: 20_000_000 });
    expect((await executeResources(["status"], env, processAdapter)).value).toContain("enabled");
    expect((await executeResources(["disable"], env, processAdapter)).kind).toBe("ok");
    expect(recordResourceSamples(env, database.value, [{ dispatchId: "three", agent: "codex", rssBytes: 1, cpuPercent: 0 }], now + 1)).toBe(0);
  });
});
