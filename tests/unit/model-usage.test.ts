import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelBudgetExceeded, trackedModelCall } from "../../src/knowledge/model-usage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function options(stateDir: string, call: () => Promise<string>, dailyLimit = 10) {
  return { stateDir, dailyLimit, kind: "summary" as const, project: "repo", session: crypto.randomUUID(), agent: "claude", model: "test", prompt: "prompt", call };
}

describe("tracked model-call reservations", () => {
  test("a second model call starts before the first one finishes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-model-usage-")); roots.push(stateDir);
    let release!: (value: string) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = trackedModelCall(options(stateDir, () => new Promise<string>((resolve) => { release = resolve; firstStarted(); })));
    await started;
    let secondStarted = false;
    const second = trackedModelCall(options(stateDir, async () => { secondStarted = true; return "second"; }));
    await second;
    expect(secondStarted).toBe(true);
    release("first");
    await first;
  });

  test("a pending reservation consumes the daily budget", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-model-usage-")); roots.push(stateDir);
    let release!: (value: string) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const first = trackedModelCall(options(stateDir, () => new Promise<string>((resolve) => { release = resolve; started(); }), 1));
    await began;
    await expect(trackedModelCall(options(stateDir, async () => "no", 1))).rejects.toBeInstanceOf(ModelBudgetExceeded);
    release("ok");
    await first;
  });

  test("a lock held by a dead process is taken over", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-model-usage-")); roots.push(stateDir);
    const root = join(stateDir, "knowledge"); mkdirSync(root);
    const lock = join(root, "model-calls.lock"); writeFileSync(lock, "999999999");
    const old = new Date(Date.now() - 61_000); utimesSync(lock, old, old);
    await expect(trackedModelCall(options(stateDir, async () => "ok"))).resolves.toBe("ok");
  });
});
