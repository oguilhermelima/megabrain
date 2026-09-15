import { describe, expect, test } from "bun:test";
import { parsePruneArgs, pruneDecision, pruneStates } from "../../src/core/orchestrate-prune.js";
const old = { state: "done", createdAt: "2020-01-01T00:00:00Z" };
const options = { olderThan: 7, states: [...pruneStates], mode: "archive" as const, dryRun: false, json: false };
const now = new Date("2026-09-15T00:00:00Z");
describe("orchestrate prune", () => {
  test("parses options", () => expect(parsePruneArgs(["--delete", "--dry-run", "--older-than", "0", "--state", "done", "--json"])).toEqual({ kind: "ok", value: { olderThan: 0, states: ["done"], mode: "delete", dryRun: true, json: true } }));
  test("keeps open and unknown states untouched", () => { expect(pruneDecision({ ...old, state: "running" }, options, now).eligible).toBe(false); expect(pruneDecision({ ...old, state: "future_state" }, options, now).eligible).toBe(false); });
  test("keeps old open records untouched", () => expect(pruneDecision({ ...old, state: "running" }, options, now)).toEqual({ eligible: false, reason: "state running is not terminal" }));
  test("uses updatedAt before createdAt and filters age", () => { expect(pruneDecision({ ...old, updatedAt: "2026-09-14T00:00:00Z" }, options, now).eligible).toBe(false); expect(pruneDecision({ ...old, updatedAt: "2020-01-01T00:00:00Z" }, options, now).eligible).toBe(true); });
  test("rejects missing and invalid timestamps", () => { expect(pruneDecision({ state: "done" }, options, now).reason).toBe("updatedAt and createdAt are missing"); expect(pruneDecision({ state: "done", createdAt: "bad" }, options, now).reason).toBe("invalid timestamp: bad"); });
});
