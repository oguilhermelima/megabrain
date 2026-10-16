import { describe, expect, test } from "bun:test";
import { parseSessionLog } from "../../src/core/session-transcript.js";

// Envelopes captured read-only from a real coordinator transcript, summaries redacted.
function envelope(body: string): string {
  return `<cross-session-message from-name="megabrain" from-mode="bypass">\n${body}\n</cross-session-message>`;
}

function notice(text: string) {
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-15T16:46:17.043Z", message: { role: "user", content: [{ type: "text", text }] } });
  const event = parseSessionLog("claude", "fixture", `${line}\n`)?.events[0];
  return { text: event?.text, notice: (event as { notice?: unknown } | undefined)?.notice };
}

describe("megabrain notice structure", () => {
  test("finished", () => {
    const result = notice(envelope("✅ codex · vs code server finished\nThe editor now opens inside the app.\n→ details: megabrain orchestrate watch 0dcc8038"));
    expect(result.notice).toEqual({ kind: "finished", agent: "codex", label: "vs code server", dispatchId: "0dcc8038", summary: "The editor now opens inside the app." });
    expect(result.text).toBe("Message from megabrain: ✅ codex · vs code server finished\ndetails: megabrain orchestrate watch 0dcc8038");
  });
  test("ask", () => {
    expect(notice(envelope("❓ claude · lane a has a question\nWhich port should it use?\n→ details: megabrain orchestrate watch 974340be")).notice)
      .toEqual({ kind: "ask", agent: "claude", label: "lane a", dispatchId: "974340be", summary: "Which port should it use?" });
  });
  test("stuck", () => {
    expect(notice(envelope("⚠️ claude · chat composer is stuck\nBuild runs in background.\n→ details: megabrain orchestrate watch 974340be")).notice)
      .toEqual({ kind: "stuck", agent: "claude", label: "chat composer", dispatchId: "974340be", summary: "Build runs in background." });
  });
  test("limit and failed", () => {
    expect((notice(envelope("⚠️ codex · lane hit its limit\nResets at noon.\n→ details: megabrain orchestrate watch 11112222")).notice as { kind: string }).kind).toBe("limit");
    expect((notice(envelope("❌ grok · lane failed\nCrashed.\n→ details: megabrain orchestrate watch 11112222")).notice as { kind: string }).kind).toBe("failed");
  });
  test("unknown shape gives other with nulls", () => {
    expect(notice(envelope("hello there\nsecond line")).notice)
      .toEqual({ kind: "other", agent: null, label: null, dispatchId: null, summary: "second line" });
  });
  test("non-megabrain peer has no notice", () => {
    const text = '<cross-session-message from-name="someone">\nhi\n</cross-session-message>';
    expect(notice(text).notice).toBeUndefined();
  });
});
