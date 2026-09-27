import { describe, expect, test } from "bun:test";
import { capTranscript, cleanTranscript, formatDispatchRead } from "../../src/core/dispatch-read.js";

describe("dispatch read", () => {
  test("formats plain and JSON output", () => {
    const value = { dispatchId: "d", pane: "", source: "host" as const, truncated: false, text: "hello" };
    expect(formatDispatchRead(value, false, 10)).toBe("source: host\nhello\n");
    expect(JSON.parse(formatDispatchRead(value, true, 10)).text).toBe("hello");
  });
  test("caps only oversized transcripts and reports truncation", () => {
    expect(capTranscript("one\ntwo\n", 100)).toEqual({ text: "one\ntwo\n", truncated: false });
    expect(capTranscript("one\ntwo\nthree\n", 8)).toEqual({ text: "three\n", truncated: true });
  });

  test("cleans a synthetic TUI redraw recording and caps the newest clean text", () => {
    const recording = "\u001b[32mLoading\u001b[0m\rLoading\rReady\nReady\n\u001b]0;title\u0007Done\u0001\n";
    const cleaned = cleanTranscript(recording, 1024);
    expect(cleaned.text).toBe("Ready\nDone\n");
    expect(cleaned.text.length).toBeLessThan(recording.length);
    expect(cleanTranscript("old\nnew\n", 4)).toEqual({ text: "new\n", truncated: true });
  });
});
