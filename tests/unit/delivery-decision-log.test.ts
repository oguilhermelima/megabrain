import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLog } from "../../src/core/delivery-decision-log.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "decision-log-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const entry = (extra: Record<string, unknown> = {}) => ({ dispatchId: "d1", outboxId: "o1", proofSource: "screen", status: "busy", composer: "empty", decision: "wait-busy", ...extra });
const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);

describe("delivery decision log", () => {
  test("collapses identical consecutive decisions and heartbeats at most once a minute", async () => {
    const dir = await root();
    let now = 1_000_000;
    const log = createDecisionLog(dir, { now: () => now });
    for (let i = 0; i < 20; i += 1) { await log.record(entry()); now += 11_000; }
    // 220 s of waiting: first line, then one heartbeat per 60 s
    const written = await lines(join(dir, "delivery-decisions.jsonl"));
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written.length).toBeLessThanOrEqual(5);
    await log.record(entry({ decision: "send" }));
    expect((await lines(join(dir, "delivery-decisions.jsonl"))).length).toBe(written.length + 1);
  });

  test("a changed read state is written immediately", async () => {
    const dir = await root();
    const log = createDecisionLog(dir, { now: () => 5 });
    await log.record(entry());
    await log.record(entry({ status: "idle" }));
    await log.record(entry({ status: "idle" }));
    expect((await lines(join(dir, "delivery-decisions.jsonl"))).length).toBe(2);
  });

  test("rotates past the threshold and keeps one previous file", async () => {
    const dir = await root();
    const path = join(dir, "delivery-decisions.jsonl");
    const log = createDecisionLog(dir, { maxBytes: 2000, now: () => 5 });
    await writeFile(`${path}.1`, "ancient\n");
    await writeFile(path, `${"x".repeat(1999)}\n`);
    await log.record(entry());
    expect((await stat(`${path}.1`)).size).toBe(2000);
    expect((await readFile(`${path}.1`, "utf8")).startsWith("x")).toBe(true);
    expect((await lines(path)).length).toBe(1);
    expect((await lines(path))[0]).toContain("wait-busy");
  });

  test("concurrent writers lose no line across a rotation", async () => {
    const dir = await root();
    const path = join(dir, "delivery-decisions.jsonl");
    const logs = [0, 1, 2, 3].map(() => createDecisionLog(dir, { maxBytes: 1500, now: () => 5 }));
    await Promise.all(logs.flatMap((log, w) => Array.from({ length: 10 }, (_, i) => log.record(entry({ outboxId: `w${w}`, status: `s${i}` })))));
    const total = (await lines(path)).length + (await lines(`${path}.1`).catch(() => [])).length;
    expect(total).toBe(40);
  });
});
