import { describe, expect, test } from "bun:test";
import { chatdInvocation } from "../../src/chat/daemon.js";

describe("chatd launch invocation", () => {
  test("runs a source checkout through the runtime with the script path", () => {
    expect(chatdInvocation("/usr/local/bin/bun", ["bun", "/repo/src/cli/index.ts"])).toEqual({ command: "/usr/local/bin/bun", args: ["/repo/src/cli/index.ts", "__chatd"] });
  });

  test("runs the compiled binary itself when argv carries a virtual script path", () => {
    expect(chatdInvocation("/Applications/Megabrain", ["/Applications/Megabrain", "/$bunfs/root/megabrain"])).toEqual({ command: "/Applications/Megabrain", args: ["__chatd"] });
  });

  test("runs the compiled binary itself when argv has no script", () => {
    expect(chatdInvocation("/Applications/Megabrain", ["/Applications/Megabrain"])).toEqual({ command: "/Applications/Megabrain", args: ["__chatd"] });
  });
});
