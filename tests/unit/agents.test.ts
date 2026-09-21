import { describe, expect, test } from "bun:test";
import { resolveParentContext } from "../../src/core/context.js";
import { classifyLiveness } from "../../src/core/liveness.js";
import { getAgent, interruptKey, registerAgent, submitKey, unregisterAgent, type Agent } from "../../src/agents/index.js";
import { ok, type Result } from "../../src/core/result.js";

const fourthAgent: Agent = {
  id: "fourth",
  matchesDescriptor(descriptor) {
    return descriptor === "fourth" || /^fourth_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor);
  },
  classifyLiveness(output): Result<{ status: "working"; reason: string }> {
    return output.includes("Fourth is working")
      ? ok({ status: "working", reason: "fourth agent is working" })
      : ok({ status: "working", reason: "fourth agent is working" });
  },
};

describe("agent registry", () => {
  test("agents own their submit and interrupt keys", () => {
    expect(submitKey("claude")).toEqual({ kind: "ok", value: "Enter" });
    expect(submitKey("codex")).toEqual({ kind: "ok", value: "Tab" });
    expect(interruptKey("claude")).toEqual({ kind: "ok", value: "Escape" });
    expect(interruptKey("codex")).toEqual({ kind: "ok", value: "Escape" });
    expect(submitKey("agy")).toMatchObject({ kind: "unknown" });
    expect(interruptKey("agy")).toMatchObject({ kind: "unknown" });
  });

  test("an unknown agent key is unknown rather than Enter", () => {
    const result = submitKey("unregistered-agent");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.reason).toContain("unregistered-agent");
  });

  test("registered agents are used by descriptor and liveness consumers", () => {
    registerAgent(fourthAgent);
    try {
      expect(resolveParentContext({ aiAgent: "fourth_2026-09-21_agent" })).toEqual({
        kind: "resolved",
        agent: "fourth",
        model: null,
        effort: null,
      });
      expect(classifyLiveness("fourth", "Fourth is working")).toEqual({
        status: "working",
        reason: "fourth agent is working",
      });
    } finally {
      unregisterAgent(fourthAgent.id);
    }
  });

  test("an unsupported agent operation is unknown rather than failed", () => {
    const agent = getAgent("agy");
    expect(agent).toBeDefined();
    const result = agent?.classifyLiveness("anything");
    expect(result?.kind).toBe("unknown");
    if (result?.kind === "unknown") expect(result.reason).toBe("liveness-unavailable: agy has no liveness markers");
    expect(classifyLiveness("agy", "anything")).toEqual({ status: "unknown", reason: null });
  });

  test("the real agents preserve current descriptor and liveness answers", () => {
    expect(resolveParentContext({ aiAgent: "claude" }).agent).toBe("claude");
    expect(resolveParentContext({ aiAgent: "codex" }).agent).toBe("codex");
    expect(resolveParentContext({ aiAgent: "agy" }).agent).toBe("agy");
    expect(resolveParentContext({ aiAgent: "claude-code_2026-09-21_agent" }).agent).toBe("claude");
    expect(resolveParentContext({ aiAgent: "codex_2026-09-21_agent" }).agent).toBe("codex");
    expect(resolveParentContext({ aiAgent: "agy_2026-09-21_agent" }).agent).toBe("agy");
    expect(classifyLiveness("codex", "Working (2s)\nesc to interrupt").status).toBe("working");
    expect(classifyLiveness("claude", "❯").status).toBe("idle");
    expect(classifyLiveness("agy", "").status).toBe("unknown");
  });
});
