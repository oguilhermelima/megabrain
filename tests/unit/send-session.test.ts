import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { selectSessionSendChannel } from "../../src/core/session-send.js";
import { executeSend } from "../../src/cli/commands/send.js";
import { matchOrcaTerminal, selectOperatorSendChannel } from "../../src/core/session-send.js";
import orcaTerminals from "../fixtures/orca-terminal-list.json";

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

  test("prefers typed operator input before queue and peer channels", () => {
    expect(selectOperatorSendChannel("claude", { tmux: true, orca: true, peerSocket: true })).toBe("tmux");
    expect(selectOperatorSendChannel("claude", { orca: true, peerSocket: true })).toBe("orca");
    expect(selectOperatorSendChannel("claude", { peerSocket: true })).toBe("peer-socket");
    expect(selectOperatorSendChannel("codex", { tmux: true, codexQueue: true })).toBe("tmux");
    expect(selectOperatorSendChannel("grok", { orca: true, leaderSocket: true })).toBe("orca");
  });

  test("matches the captured Orca inventory by agent and worktree, then title", () => {
    const terminals = (orcaTerminals.result as { terminals: unknown[] }).terminals;
    expect(matchOrcaTerminal(terminals, { agent: "claude", worktreePath: "/Users/operator/Workspaces/Canto", title: "Seis mudanças visuais paralelas" })).toMatchObject({ handle: "term_5de39f63-41df-4423-8e47-4ae031b5cba4" });
    expect(matchOrcaTerminal(terminals, { agent: "claude", worktreePath: "/missing", title: "Seis mudanças visuais paralelas" })).toBeUndefined();
    expect(matchOrcaTerminal(terminals, { agent: "claude", worktreePath: "/Users/operator/Workspaces/Canto" })).toBeUndefined();
  });

  test("submits immediately over foreign operator composer text", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const calls: string[][] = [];
    const result = await deliverOperatorText({
      terminalId: "term-1", agent: "claude", text: "hello",
      read: async () => "❯ draft",
      send: async (text, enter) => { calls.push([text, String(enter)]); return "ok"; },
    });
    expect(result).toEqual({ delivered: true });
    expect(calls).toEqual([["hello", "true"]]);
  });

  test("sends through a dialog and an initially unreadable composer", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const calls: string[][] = [];
    const send = async (text = "", enter = false) => { calls.push([text, String(enter)]); return "ok"; };
    expect(await deliverOperatorText({ terminalId: "term-1", agent: "claude", text: "hello", read: async () => "Choose an option", send })).toEqual({ delivered: true });
    expect(await deliverOperatorText({ terminalId: "term-1", agent: "claude", text: "hello", read: async () => undefined, send })).toEqual({ delivered: true });
    expect(calls).toEqual([["hello", "true"], ["hello", "true"]]);
  });

  test("submits again if the composer still contains the message after the first submit", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    let screen = "❯ ";
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => screen,
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); screen = text === "" ? "❯ " : "❯ hello"; return "ok"; },
    });
    expect(events).toEqual(["send:hello:true", "send::true"]);
    expect(result).toEqual({ delivered: true });
  });

  test("does not resend when the composer no longer contains the message", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    let screen = "❯ ";
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => screen,
      send: async () => { screen = "❯ other text"; return "ok"; },
    });
    expect(result).toEqual({ delivered: true });
  });

  test("submits even when the post-submit screen is unreadable", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const result = await deliverOperatorText({ agent: "claude", text: "hello", read: async () => undefined, send: async () => "ok" });
    expect(result).toEqual({ delivered: true });
  });

  test("submits a paste immediately and retries Enter if the text remains", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    let pasted = false;
    let readsAfterPaste = 0;
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => {
        if (!pasted) return "❯ ";
        readsAfterPaste += 1;
        return readsAfterPaste === 1 ? "❯ hello" : "❯ ";
      },
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); if (text !== "") pasted = true; return "ok"; },
    });
    expect(result).toEqual({ delivered: true });
    expect(events).toEqual(["send:hello:true", "send::true"]);
    expect(readsAfterPaste).toBe(2);
  });

  test("does not wait when the paste read-back remains empty", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    const started = Date.now();
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => "❯ ",
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); return "ok"; },
    });
    expect(Date.now() - started).toBeLessThan(100);
    expect(events).toEqual(["send:hello:true"]);
    expect(result).toEqual({ delivered: true });
  });

  test("sends without waiting for a readable empty composer", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const screens: (string | undefined)[] = [undefined, "❯ hello"];
    let reads = 0;
    let pasted = false;
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => {
        if (pasted) return screens[Math.min(reads++, screens.length - 1)];
        return screens[Math.min(reads++, screens.length - 1)];
      },
      send: async (text) => { if (text !== "") pasted = true; return "ok"; },
    });
    expect(result).toEqual({ delivered: true });
    expect(reads).toBe(1);
  });

  test("returns delivered false when an actual session has no channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-send-test-"));
    try {
      const result = await executeSend(["--session", "claude:session-without-channel", "--text", "hello", "--json"], {
        MEGABRAIN_OPERATOR: "1", MEGABRAIN_STATE_DIR: root, HOME: root,
      }, createProcessAdapter());

      expect(result).toEqual({
        kind: "ok",
        value: `${JSON.stringify({ delivered: false, channel: "typed", detail: "no delivery channel is available for this session" }, null, 2)}\n`,
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
