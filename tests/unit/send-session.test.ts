import { describe, expect, test } from "bun:test";
import { route } from "../../src/cli/router.js";
import { selectSessionSendChannel } from "../../src/core/session-send.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const noProcess: ProcessAdapter = {
  async run() { return { kind: "failed", error: "unexpected process call", exitCode: 1 }; },
  async spawn() { return { kind: "failed", error: "unexpected process call", exitCode: 1 }; },
};

describe("send to agent sessions", () => {
  test("selects each agent's preferred channel and tmux fallback", () => {
    expect(selectSessionSendChannel("claude", { peerSocket: true, tmux: true })).toBe("peer-socket");
    expect(selectSessionSendChannel("grok", { leaderSocket: true, tmux: true })).toBe("leader-socket");
    expect(selectSessionSendChannel("codex", { codexQueue: true, tmux: true })).toBe("codex-queue");
    expect(selectSessionSendChannel("agy", { tmux: true })).toBe("tmux");
  });

  test("reports no channel instead of claiming delivery", () => {
    expect(selectSessionSendChannel("claude", {})).toBeUndefined();
  });

  test("refuses operator mode from an agent session", async () => {
    const result = await route(["send", "--session", "claude:session-1", "--text", "hello", "--operator"], {
      environment: { CLAUDE_CODE_SESSION_ID: "agent-session" }, processAdapter: noProcess,
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("cannot act as the operator");
  });
});
