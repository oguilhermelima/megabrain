import { describe, expect, test } from "bun:test";
import { parseSessionLog } from "../../src/core/session-transcript.js";

const PATH = "/var/folders/01/pdv69_497hscv2q58cjmzly00000gn/T/orca-paste-1792082630521-87b0dafc-acde-4538-8661-2a315133a83c.png";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function parse(content: unknown) {
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-15T16:46:17.043Z", message: { role: "user", content } });
  return parseSessionLog("claude", "fixture", `${line}\n`)?.events.map(({ kind, text, ...rest }) => ({ kind, text, images: (rest as { images?: unknown }).images }));
}

describe("claude user images", () => {
  test("exposes a pasted image path and strips its source line", () => {
    expect(parse([{ type: "text", text: "[Image #54] ficou branco" }, { type: "text", text: `[Image: source: ${PATH}]` }]))
      .toEqual([{ kind: "user", text: "[Image #54] ficou branco", images: [{ path: PATH }] }]);
  });
  test("keeps an image-only turn as a user event", () => {
    expect(parse([{ type: "text", text: `[Image: source: ${PATH}]` }]))
      .toEqual([{ kind: "user", text: "", images: [{ path: PATH }] }]);
  });
  test("exposes inline base64 image blocks as data URLs", () => {
    expect(parse([{ type: "text", text: "[Image #7]" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PIXEL } }]))
      .toEqual([{ kind: "user", text: "[Image #7]", images: [{ dataUrl: `data:image/png;base64,${PIXEL}` }] }]);
  });
  test("skips inline images over 2 MB", () => {
    const big = "A".repeat(3 * 1024 * 1024);
    expect(parse([{ type: "text", text: "[Image #8] x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }]))
      .toEqual([{ kind: "user", text: "[Image #8] x", images: undefined }]);
  });
  test("leaves path text unredacted and plain turns without images", () => {
    expect(parse("hello")).toEqual([{ kind: "user", text: "hello", images: undefined }]);
  });
});
