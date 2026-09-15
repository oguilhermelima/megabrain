import { describe, expect, test } from "bun:test";
import { capTranscript, formatDispatchRead } from "../../src/core/dispatch-read.js";

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
});
