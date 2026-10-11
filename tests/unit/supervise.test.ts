import { describe, expect, test } from "bun:test";
import { classifySupervision, recommendationFor } from "../../src/core/supervise.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");

describe("supervision classification", () => {
  test("distinguishes the actionable causes and preserves limit reset time", () => {
    const cases = [
      { frame: "■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:43 PM.\nGPT-6-Luna high · Context 27% left · weekly 73% left · 5h 0% left", expected: { cause: "usage-limit", resetAt: "1:43 PM" } },
      { agent: "claude", frame: "API Error: authentication required", expected: { cause: "auth-required" } },
      { frame: "Trust this project?\n1. Yes, continue", expected: { cause: "dialog-waiting" } },
      { frame: "❯ [megabrain dispatch: worker]", promptUnsubmitted: true, expected: { cause: "prompt-unsubmitted" } },
      { processAlive: false, expected: { cause: "process-exited" } },
      { paneExists: false, expected: { cause: "pane-gone" } },
      { frame: "✢ Working (running a build)", activityAt: now - 16 * 60_000, expected: { cause: "no-activity", command: "running a build" } },
      { frame: "some unfamiliar screen", expected: { cause: "unknown" } },
    ] as const;

    for (const item of cases) {
      expect(classifySupervision({ agent: item.agent ?? "codex", frame: item.frame ?? "", now, activityAt: item.activityAt ?? now, paneExists: item.paneExists ?? true, processAlive: item.processAlive ?? true, promptUnsubmitted: item.promptUnsubmitted ?? false })).toMatchObject(item.expected);
    }
  });

  test("recommends an operator action for each finding", () => {
    expect(recommendationFor({ cause: "usage-limit", resetAt: "1:43 PM" })).toContain("1:43 PM");
    expect(recommendationFor({ cause: "auth-required" })).toContain("log in");
    expect(recommendationFor({ cause: "dialog-waiting" })).toContain("answer");
    expect(recommendationFor({ cause: "prompt-unsubmitted" })).toContain("resubmitted");
    expect(recommendationFor({ cause: "process-exited", worktreePath: "/repo", dirtyFiles: ["src/a.ts"] })).toContain("src/a.ts");
    expect(recommendationFor({ cause: "pane-gone", worktreePath: "/repo", dirtyFiles: [] })).toContain("respawn");
    expect(recommendationFor({ cause: "no-activity", command: "running a build" })).toContain("possibly hung");
    expect(recommendationFor({ cause: "unknown" })).toBeUndefined();
  });
});
