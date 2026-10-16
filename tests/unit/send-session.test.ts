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

  test("reports a busy operator composer without typing over it", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const calls: string[][] = [];
    const result = await deliverOperatorText({
      terminalId: "term-1", agent: "claude", text: "hello",
      read: async () => "❯ draft",
      send: async (text, enter) => { calls.push([text, String(enter)]); return "ok"; },
    });
    expect(result).toEqual({ delivered: false, detail: "The session already has text in its input box in its terminal; send it or clear it there, then try again." });
    expect(calls).toEqual([]);
  });

  test("explains a dialog, an unreadable terminal and unconfirmed text for the person", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const send = async () => "ok";
    expect(await deliverOperatorText({ terminalId: "term-1", agent: "claude", text: "hello", read: async () => "Choose an option", send }))
      .toEqual({ delivered: false, detail: "The session is showing a question in its terminal; answer it there first." });
    expect(await deliverOperatorText({ terminalId: "term-1", agent: "claude", text: "hello", read: async () => undefined, send }))
      .toEqual({ delivered: false, detail: "Could not read the session's terminal." });
    expect(await deliverOperatorText({ terminalId: "term-1", agent: "claude", text: "hello", read: async () => "❯ ", send }))
      .toEqual({ delivered: false, detail: "The text could not be confirmed in the session's input. It was left in the input box unsent; send or clear it in the terminal." });
  });

  test("clears exactly what it typed when the text cannot be confirmed, and says so", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    let screen = "❯ ";
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => screen,
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); screen = "❯ something else"; return "ok"; },
      clear: async () => { events.push("clear"); screen = "❯ "; return "ok"; },
    });
    expect(events).toEqual(["send:hello:false", "clear"]);
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("cleared");
  });

  test("says the text may still be unsent when it cannot clear it", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    let screen = "❯ ";
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => screen,
      send: async () => { screen = "❯ something else"; return "ok"; },
      clear: async () => "ok",
    });
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("still");
  });

  test("says the text was left in the input when no clear is available", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const result = await deliverOperatorText({ agent: "claude", text: "hello", read: async () => "❯ ", send: async () => "ok" });
    expect(result.detail).toContain("left");
  });

  test("waits for a slow composer to show the paste, then presses Enter once", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    let pasted = false;
    let readsAfterPaste = 0;
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => {
        if (!pasted) return "❯ ";
        readsAfterPaste += 1;
        return readsAfterPaste >= 3 ? "❯ hello" : "❯ ";
      },
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); if (text !== "") pasted = true; return "ok"; },
      clear: async () => { events.push("clear"); return "ok"; },
      pollIntervalMs: 5, confirmTimeoutMs: 500,
    });
    expect(result).toEqual({ delivered: true });
    expect(events).toEqual(["send:hello:false", "send::true"]);
    expect(readsAfterPaste).toBe(3);
  });

  test("fails after the deadline and clears when the paste never shows", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const events: string[] = [];
    const started = Date.now();
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => "❯ ",
      send: async (text, enter) => { events.push(`send:${text}:${enter}`); return "ok"; },
      clear: async () => { events.push("clear"); return "ok"; },
      pollIntervalMs: 10, confirmTimeoutMs: 100,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(events).toEqual(["send:hello:false", "clear"]);
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("cleared");
  });

  test("waits for a visible empty composer before pasting", async () => {
    const { deliverOperatorText } = await import("../../src/core/session-send.js");
    const screens: (string | undefined)[] = [undefined, "Loading conversation", "❯ "];
    let reads = 0;
    let pasted = false;
    const result = await deliverOperatorText({
      agent: "claude", text: "hello",
      read: async () => {
        if (pasted) return "❯ hello";
        return screens[Math.min(reads++, screens.length - 1)];
      },
      send: async (text) => { if (text !== "") pasted = true; return "ok"; },
      pollIntervalMs: 5, readyTimeoutMs: 500,
    });
    expect(result).toEqual({ delivered: true });
    expect(reads).toBe(3);
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
