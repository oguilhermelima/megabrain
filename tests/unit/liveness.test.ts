import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { classifyLiveness } from "../../src/core/liveness.js";

describe("classifyLiveness", () => {
  test("recognizes each Codex frame", () => {
    expect(classifyLiveness("codex", "Messages to be submitted after next tool call\npress esc to interrupt and send immediately").status).toBe("pending-check");
    expect(classifyLiveness("codex", "Working (2s)\nesc to interrupt").status).toBe("working");
    expect(classifyLiveness("codex", "› Ask Codex to do anything").status).toBe("idle");
    expect(classifyLiveness("codex", "You've hit your usage limit for this account.\nSwitch to another model now,").status).toBe("blocked");
    expect(classifyLiveness("codex", "Hook error:\nsocket connection was closed unexpectedly").status).toBe("blocked");
  });
  test("recognizes each Claude frame", () => {
    expect(classifyLiveness("claude", "Working\nesc to interrupt").status).toBe("working");
    expect(classifyLiveness("claude", "❯").status).toBe("idle");
    expect(classifyLiveness("claude", "API Error:\nauthentication").status).toBe("blocked");
  });
  test("recognizes measured idle and working frames even when the composer is empty", async () => {
    const fixture = async (name: string) => readFile(new URL(`../fixtures/agent-liveness/${name}`, import.meta.url), "utf8");
    const claudeIdle = await fixture("claude-tmux-idle.txt");
    const claudeWorking = await fixture("claude-working-frame.txt");
    const claudeMeasuredWorking = await fixture("claude-tmux-working.txt");
    const codexIdle = await fixture("codex-tmux-idle.txt");
    const codexWorking = await fixture("codex-tmux-working.txt");

    expect(classifyLiveness("claude", claudeIdle).status).toBe("idle");
    expect(classifyLiveness("claude", claudeWorking).status).toBe("working");
    expect(classifyLiveness("claude", claudeMeasuredWorking).status).toBe("working");
    expect(classifyLiveness("codex", codexIdle).status).toBe("idle");
    expect(classifyLiveness("codex", codexWorking).status).toBe("working");
  });
  test("keeps absent, quoted, and unknown frames unknown", () => {
    expect(classifyLiveness("codex", "").status).toBe("unknown");
    expect(classifyLiveness("codex", "quoted: You've hit your usage limit for\nSwitch to another model now,").status).toBe("unknown");
    expect(classifyLiveness("other", "Working (1s)\nesc to interrupt").status).toBe("unknown");
  });
});
