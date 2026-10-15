import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { selectSessionSendChannel } from "../../src/core/session-send.js";
import { executeSend } from "../../src/cli/commands/send.js";

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

  test("returns delivered false when an actual session has no channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-send-test-"));
    try {
      const result = await executeSend(["--session", "claude:session-without-channel", "--text", "hello", "--json"], {
        MEGABRAIN_OPERATOR: "1", MEGABRAIN_STATE_DIR: root, HOME: root,
      }, createProcessAdapter());

      expect(result).toEqual({
        kind: "ok",
        value: `${JSON.stringify({ delivered: false, channel: "none", detail: "no delivery channel is available for this session" }, null, 2)}\n`,
        exitCode: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses operator mode from an agent session", async () => {
    const result = await route(["send", "--session", "claude:session-1", "--text", "hello", "--operator"], {
      environment: { CLAUDE_CODE_SESSION_ID: "agent-session" }, processAdapter: createProcessAdapter(),
    });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("cannot act as the operator");
  });
});
