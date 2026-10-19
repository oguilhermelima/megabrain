import { describe, expect, test } from "bun:test";
import { sendSessionMessage, type SessionSendChannel } from "../../src/core/session-send.js";

const handlers = (calls: string[], accepted: SessionSendChannel = "peer-socket") => ({
  "peer-socket": async () => { calls.push("peer-socket"); return accepted === "peer-socket"; },
  "leader-socket": async () => { calls.push("leader-socket"); return accepted === "leader-socket"; },
  "agy-language-server": async () => { calls.push("agy-language-server"); return accepted === "agy-language-server"; },
  "codex-queue": async () => { calls.push("codex-queue"); return accepted === "codex-queue"; },
  typed: async () => { calls.push("typed"); return accepted === "typed"; },
});

describe("central session delivery", () => {
  test.each(["reply", "change", "parent-notice", "supervisor", "operator-send", "turn-end", "spawn-fallback"] as const)("routes %s through the same target channel order", async (caller) => {
    const calls: string[] = [];
    const recorded: string[] = [];
    const result = await sendSessionMessage({ caller, messageId: `${caller}-message`, target: { agent: "claude" }, text: "hello", channels: handlers(calls), recordChannel: async (channel) => { recorded.push(channel); } });
    expect(result).toMatchObject({ delivered: true, channel: "peer-socket" });
    expect(calls).toEqual(["peer-socket"]);
    expect(recorded).toEqual(["peer-socket"]);
  });

  test("delivers a message id once even when two callers race", async () => {
    const calls: string[] = [];
    const input = { caller: "reply" as const, messageId: "same-message", target: { agent: "claude" }, text: "hello", channels: handlers(calls), recordChannel: async () => undefined };
    const results = await Promise.all([sendSessionMessage(input), sendSessionMessage({ ...input, caller: "change" })]);
    expect(results.every((result) => result.delivered)).toBe(true);
    expect(calls).toEqual(["peer-socket"]);
  });

  test("evicts old successful entries after the bounded deduplication window fills", async () => {
    const calls: string[] = [];
    const input = (messageId: string) => ({ caller: "reply" as const, messageId, target: { agent: "claude" }, text: "hello", channels: handlers(calls), recordChannel: async () => undefined });
    for (let index = 0; index < 1_001; index += 1) await sendSessionMessage(input(`bounded-${index}`));

    await sendSessionMessage(input("bounded-0"));

    expect(calls).toHaveLength(1_002);
  });

  test("falls through to typed submit after direct channels fail", async () => {
    const calls: string[] = [];
    const result = await sendSessionMessage({ caller: "reply", messageId: "fallback-message", target: { agent: "claude" }, text: "hello", channels: handlers(calls, "typed"), recordChannel: async () => undefined });
    expect(result).toMatchObject({ delivered: true, channel: "typed" });
    expect(calls).toEqual(["peer-socket", "leader-socket", "agy-language-server", "codex-queue", "typed"]);
  });
});
