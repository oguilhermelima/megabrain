import { describe, expect, test } from "bun:test";
import { formatDispatchMessage } from "../../src/core/chat-message-format.js";
import { orca } from "../../src/hosts/orca.js";

const message = {
  dispatchId: "dispatch-d32d916a",
  chatName: "fix-x",
  agent: "codex",
  type: "done",
  text: "The sentence. More detail.",
  direction: "parent-bound" as const,
};

describe("orca one-line message", () => {
  test("joins the parts without an arrow after the separator", () => {
    const sent = orca.send({ workspaceId: null, terminalId: "t1", text: formatDispatchMessage(message) });
    if (sent.kind !== "ok") throw new Error("send unavailable");
    const text = sent.value.args[sent.value.args.indexOf("--text") + 1];
    expect(text).toBe("✅ codex · fix-x finished — The sentence. — details: megabrain orchestrate watch d32d916a");
  });

  test("keeps the arrow in the three-line form", () => {
    expect(formatDispatchMessage(message).split("\n")[2]).toBe("→ details: megabrain orchestrate watch d32d916a");
    expect(formatDispatchMessage({ ...message, direction: "child-bound" }).split("\n")[2]).toBe("→ full text: megabrain check");
  });

  test("leaves text without a pointer line unchanged", () => {
    const sent = orca.send({ workspaceId: null, terminalId: "t1", text: "a\nb" });
    if (sent.kind !== "ok") throw new Error("send unavailable");
    expect(sent.value.args[sent.value.args.indexOf("--text") + 1]).toBe("a — b");
  });
});
