import { describe, expect, test } from "bun:test";
import { tagTranscriptOrigins, type TranscriptOriginDispatch } from "../../src/core/transcript-origin.js";
import type { TranscriptEvent } from "../../src/core/session-transcript.js";

const event = (text: string, kind: TranscriptEvent["kind"] = "user"): TranscriptEvent => ({ id: "event-1", at: null, kind, text });

const dispatch: TranscriptOriginDispatch = {
  dispatchId: "dispatch-20261015120000000-7-a1b2c3d4",
  chatName: "child chat",
  parentAgent: "codex",
  parentChatName: null,
  parentSessionId: "codex:thread-parent-12345678",
};

describe("transcript origin", () => {
  test("tags captured Codex and Claude child messages as parent without changing text", () => {
    const brief = event("[megabrain dispatch: codex feat/example]\n\nRun the task.");
    const reply = event("💬 megabrain · parent chat reply\nPlease continue.\n→ full text: megabrain check");

    const tagged = tagTranscriptOrigins([brief, reply], dispatch, []);

    expect(tagged).toEqual([
      { ...brief, origin: { kind: "parent", label: "codex · 12345678", dispatchId: null, sessionId: dispatch.parentSessionId } },
      { ...reply, origin: { kind: "parent", label: "codex · 12345678", dispatchId: null, sessionId: dispatch.parentSessionId } },
    ]);
  });

  test("uses the known parent chat name for child-bound directions", () => {
    const known = { ...dispatch, parentChatName: "parent chat" };
    const change = event("🔀 megabrain · parent chat new direction\nStop the approach and follow this instead.");

    expect(tagTranscriptOrigins([change], known, [])[0]?.origin).toEqual({
      kind: "parent", label: "parent chat", dispatchId: null, sessionId: dispatch.parentSessionId,
    });
  });

  test("resolves a captured child notice suffix and Claude peer envelope", () => {
    const notice = event("<cross-session-message from-name=\"megabrain\">\n✅ claude · child chat finished — Done. — details: megabrain orchestrate watch a1b2c3d4\n</cross-session-message>");
    const records = [{ ...dispatch, label: "child chat" }];

    expect(tagTranscriptOrigins([notice], null, records)[0]).toEqual({
      ...notice,
      origin: { kind: "child", label: "child chat", dispatchId: dispatch.dispatchId, sessionId: null },
    });
  });

  test("leaves events with no recognized relay untouched", () => {
    const ordinary = event("Please inspect the implementation.", "assistant");
    expect(tagTranscriptOrigins([ordinary], dispatch, [])).toEqual([ordinary]);
  });
});
