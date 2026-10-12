import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agyLogRecord, backgroundTasks, classifyRecordedError, classifySupervision, recommendationFor } from "../../src/core/supervise.js";

const now = Date.parse("2026-10-11T12:03:00.000Z");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(import.meta.dir, "../fixtures/supervise", name), "utf8")) as Record<string, unknown>;

describe("supervision classification", () => {
  test("classifies Grok CLI error text from captured source strings", () => {
    const grok = (name: string) => readFileSync(resolve(import.meta.dir, `../fixtures/supervise/${name}.txt`), "utf8");
    const finding = (name: string) => classifySupervision({ frame: grok(name), paneExists: true, processAlive: true, promptUnsubmitted: false });
    expect(finding("grok-usage-limit").cause).toBe("usage-limit");
    expect(finding("grok-rate-limited")).toMatchObject({ cause: "rate-limited", errorCode: "429" });
    expect(finding("grok-server-error").cause).toBe("server-error");
    expect(finding("grok-network").cause).toBe("network");
    expect(finding("grok-auth-required").cause).toBe("auth-required");
  });

  test("classifies provider errors from the agents' structured records", () => {
    expect(classifyRecordedError("codex", fixture("codex-usage-limit.json"), { now })).toMatchObject({ cause: "usage-limit", resetAt: "1:43 PM" });
    expect(classifyRecordedError("claude", fixture("claude-rate-limited.json"), { now, idlePrompt: true })).toMatchObject({ cause: "rate-limited", errorCode: "429" });
    expect(classifyRecordedError("claude", fixture("claude-server-error.json"), { now })).toMatchObject({ cause: "server-error", errorCode: "529" });
    expect(classifyRecordedError("codex", fixture("codex-network.json"), { now })).toMatchObject({ cause: "network" });
    expect(classifyRecordedError("codex", fixture("codex-auth-required.json"), { now })).toMatchObject({ cause: "auth-required" });
  });

  test("does not mistake Codex quota warnings or stale warnings for a usage refusal", () => {
    for (const warning of [
      "⚠ 5h limit: 48% left · resets at 10:06",
      "⚠ weekly limit: 24% left · resets at 10:06",
    ]) {
      expect(classifySupervision({ frame: `${warning}\nWorking…\n5h 97% left`, paneExists: true, processAlive: true, promptUnsubmitted: false }).cause).toBe("unknown");
    }
    expect(classifySupervision({
      frame: "You've hit your usage limit for this model. Switch to another model now.",
      paneExists: true, processAlive: true, promptUnsubmitted: false,
    }).cause).toBe("usage-limit");
    // Claude's own limit notice, captured from a real transcript (system, informational).
    expect(classifySupervision({
      frame: "Usage limit reached · continuing automatically at 1pm · esc or type to cancel",
      paneExists: true, processAlive: true, promptUnsubmitted: false,
    }).cause).toBe("usage-limit");
    expect(classifySupervision({
      frame: "You've hit your usage limit for this model.\nSwitch to another model now.\n\nWorking (12s)\nesc to interrupt",
      paneExists: true, processAlive: true, promptUnsubmitted: false,
    }).cause).toBe("unknown");
  });

  test("ignores errors that recovered or have newer progress and reports only a final two-minute error", () => {
    const error = fixture("codex-server-error.json");
    expect(classifyRecordedError("codex", error, { now: Date.parse("2026-10-11T12:00:30.000Z") })).toMatchObject({ cause: "unknown" });
    expect(classifyRecordedError("codex", error, { now, lastProgressAt: now - 1_000 })).toMatchObject({ cause: "unknown" });
    expect(classifyRecordedError("codex", error, { now, idlePrompt: true })).toMatchObject({ cause: "server-error", errorCode: "502" });
    expect(classifyRecordedError("codex", fixture("codex-unknown-error.json"), { now })).toMatchObject({ cause: "unknown" });
  });

  test("requires an event timestamp unless the error remains on an idle agent screen", () => {
    const error = fixture("claude-server-error.json");
    const withoutTimestamp = { ...error };
    delete withoutTimestamp.timestamp;
    expect(classifyRecordedError("claude", withoutTimestamp, { now })).toMatchObject({ cause: "unknown" });
    expect(classifyRecordedError("claude", error, { now: Date.parse("2026-10-11T12:00:30.000Z"), idlePrompt: true })).toMatchObject({ cause: "server-error", errorCode: "529" });
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

describe("background task detection", () => {
  const turnLine = "✻ Brewed for 9m 47s · done 6:49 PM · 1 shell, 1 monitor still running";
  const footer = "⏵⏵ bypass permissions on · 1 shell, 1 monitor · ← 3 agents";

  test("counts shells and monitors from the turn line and from the footer", () => {
    expect(backgroundTasks(`${turnLine}\n\n❯ \n${footer}`)).toBe(2);
    expect(backgroundTasks(footer)).toBe(2);
    expect(backgroundTasks("✻ Cooked for 1m 2s · 3 shells still running")).toBe(3);
  });

  test("returns undefined when no shell or monitor runs, and never counts agents", () => {
    expect(backgroundTasks("✻ Brewed for 9m 47s\n❯ \n⏵⏵ bypass permissions on · ← 3 agents")).toBeUndefined();
    expect(backgroundTasks("the shell script exited; run the monitor later")).toBeUndefined();
    expect(backgroundTasks("")).toBeUndefined();
  });
});

// Antigravity CLI writes provider failures to its --log-file as glog lines, which carry no year;
// the fixtures are real lines from 2026-10-11 with ids redacted.
describe("agy recorded errors", () => {
  const log = (name: string): string => readFileSync(new URL(`../fixtures/supervise/${name}`, import.meta.url), "utf8");
  const after = Date.parse("2026-10-11T14:10:00");

  test("reads the quota refusal as a usage limit with its reset", () => {
    const record = agyLogRecord(log("agy-usage-limit.log"), 2026);
    expect(classifyRecordedError("agy", record, { now: after })).toMatchObject({ cause: "usage-limit", resetAt: "in 44m24s" });
  });

  test("reads a failed request as a network error", () => {
    expect(classifyRecordedError("agy", agyLogRecord(log("agy-network.log"), 2026), { now: after })).toMatchObject({ cause: "network" });
  });

  test("a background cache failure is not the agent's error, and a later message means it moved on", () => {
    expect(agyLogRecord(log("agy-usage-limit.log").split("\n")[0] ?? "", 2026)).toBeUndefined();
    expect(classifyRecordedError("agy", agyLogRecord(log("agy-recovered.log"), 2026), { now: after })).toMatchObject({ cause: "unknown" });
  });

  test("dates the line in local time in the given year", () => {
    expect(agyLogRecord(log("agy-usage-limit.log"), 2026)).toMatchObject({ timestamp: new Date(2026, 9, 11, 14, 6, 4, 65).toISOString() });
  });
});
