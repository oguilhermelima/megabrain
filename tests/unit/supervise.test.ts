import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyRecordedError, recommendationFor } from "../../src/core/supervise.js";

const now = Date.parse("2026-10-11T12:03:00.000Z");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(import.meta.dir, "../fixtures/supervise", name), "utf8")) as Record<string, unknown>;

describe("supervision classification", () => {
  test("classifies provider errors from the agents' structured records", () => {
    expect(classifyRecordedError("codex", fixture("codex-usage-limit.json"), { now })).toMatchObject({ cause: "usage-limit", resetAt: "1:43 PM" });
    expect(classifyRecordedError("claude", fixture("claude-rate-limited.json"), { now, idlePrompt: true })).toMatchObject({ cause: "rate-limited", errorCode: "429" });
    expect(classifyRecordedError("claude", fixture("claude-server-error.json"), { now })).toMatchObject({ cause: "server-error", errorCode: "529" });
    expect(classifyRecordedError("codex", fixture("codex-network.json"), { now })).toMatchObject({ cause: "network" });
    expect(classifyRecordedError("codex", fixture("codex-auth-required.json"), { now })).toMatchObject({ cause: "auth-required" });
  });

  test("ignores errors that recovered or have newer progress and reports only a final two-minute error", () => {
    const error = fixture("codex-server-error.json");
    expect(classifyRecordedError("codex", error, { now: Date.parse("2026-10-11T12:00:30.000Z") })).toMatchObject({ cause: "unknown" });
    expect(classifyRecordedError("codex", error, { now, lastProgressAt: now - 1_000 })).toMatchObject({ cause: "unknown" });
    expect(classifyRecordedError("codex", error, { now, idlePrompt: true })).toMatchObject({ cause: "server-error", errorCode: "502" });
    expect(classifyRecordedError("codex", fixture("codex-unknown-error.json"), { now })).toMatchObject({ cause: "unknown" });
  });

  test("recommends the next action and names provider errors", () => {
    expect(recommendationFor({ cause: "usage-limit", resetAt: "1:43 PM" })).toContain("1:43 PM");
    expect(recommendationFor({ cause: "rate-limited", errorCode: "429" })).toContain("429");
    expect(recommendationFor({ cause: "server-error", errorCode: "502" })).toContain("502");
    expect(recommendationFor({ cause: "network", errorCode: "timeout" })).toContain("timeout");
    expect(recommendationFor({ cause: "auth-required" })).toContain("log in");
    expect(recommendationFor({ cause: "dialog-waiting" })).toContain("answer");
    expect(recommendationFor({ cause: "prompt-unsubmitted" })).toContain("resubmitted");
    expect(recommendationFor({ cause: "process-exited", worktreePath: "/repo", dirtyFiles: ["src/a.ts"] })).toContain("src/a.ts");
    expect(recommendationFor({ cause: "pane-gone", worktreePath: "/repo", dirtyFiles: [] })).toContain("respawn");
    expect(recommendationFor({ cause: "unknown" })).toBeUndefined();
  });
});
