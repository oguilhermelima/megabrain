import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { classifyLiveness, startupDialogCause, waitForStableIdle } from "../../src/core/liveness.js";

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
  test("waits through a startup dialog until the user dismisses it", async () => {
    const frames = ["Do you trust the files in this folder?\nTrust folder", "Do you trust the files in this folder?\nTrust folder", "❯"];
    let reads = 0;
    let keysSent = 0;
    const result = await waitForStableIdle("claude", 2500, async () => {
      const frame = frames[Math.min(reads++, frames.length - 1)] ?? "";
      return { kind: "ok", value: frame };
    }, "timeout", async () => { keysSent += 1; return { kind: "ok", value: undefined }; });
    expect(result.kind).toBe("ok");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(keysSent).toBe(0);
  });

  test("keeps absent, quoted, and unknown frames unknown", () => {
    expect(classifyLiveness("codex", "").status).toBe("unknown");
    expect(classifyLiveness("codex", "quoted: You've hit your usage limit for\nSwitch to another model now,").status).toBe("unknown");
    expect(classifyLiveness("other", "Working (1s)\nesc to interrupt").status).toBe("unknown");
  });

  test("blocks startup dialogs with their captured frame and never answers them", async () => {
    const frames = [
      ["claude", "Do you trust the files in this folder?\nTrust folder 1\nNo, exit"],
      ["codex", "Hooks need review\nPress Enter to review hooks"],
      ["codex", "Update available\nSkip until next version"],
      ["claude", "Permission required\nAllow once\nAllow always\nReject"],
      ["claude", "Would you like to continue?\n1. Yes\n2. No"],
      ["claude", "What would you like to do?\n1. Continue\n2. Stop"],
    ] as const;
    for (const [agent, frame] of frames) {
      expect(startupDialogCause(agent, frame)).not.toBeUndefined();
      let answered = false;
      const result = await waitForStableIdle(agent, 2000, async () => ({ kind: "ok", value: frame }), "timeout", async () => {
        answered = true;
        return { kind: "ok", value: undefined };
      });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.error.toLowerCase()).toContain("dialog");
        expect(result.error).toContain(frame);
      }
      expect(answered).toBe(false);
    }
  });
});
