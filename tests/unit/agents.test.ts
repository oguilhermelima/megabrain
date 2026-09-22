import { describe, expect, test } from "bun:test";
import { resolveParentContext } from "../../src/core/context.js";
import { classifyLiveness } from "../../src/core/liveness.js";
import { commandLine, getAgent, interruptKey, registerAgent, submitKey, unregisterAgent, type Agent } from "../../src/agents/index.js";
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
  test("agents own their launch flags and option syntax", () => {
    expect(commandLine("codex", { model: "gpt-5", effort: "high", browser: true, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'codex --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false -c model="gpt-5" -c model_reasoning_effort="high" -c mcp_servers.playwright.enabled=true',
    });
    expect(commandLine("claude", { model: "claude-sonnet-4-6", effort: "high", browser: true, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'claude --dangerously-skip-permissions --model "claude-sonnet-4-6" --effort "high"',
    });
    expect(commandLine("agy", { model: "gemini-3.8-flash-high", effort: "high", browser: true, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'agy --dangerously-skip-permissions --model "gemini-3.8-flash-high"',
    });
  });

  test("browser configuration and agent arguments remain appended", () => {
    expect(commandLine("codex", { model: null, effort: null, browser: false, agentArgs: ["--extra-flag", "value"] })).toEqual({
      kind: "ok",
      value: "codex --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false -c mcp_servers.playwright.enabled=false --extra-flag value",
    });
  });

  // Codex's own startup update check can pop a modal ("Update available! ... Press enter to
  // continue") over an idle composer after readiness has already been confirmed, and an Enter
  // meant for the prompt then lands on the modal's default option instead — which runs a remote
  // installer (`curl ... | sh`). Disabling the check at launch removes the modal, not just its
  // Enter risk.
  test("codex launches with the startup update check disabled", () => {
    const launched = commandLine("codex", { model: null, effort: null, browser: false, agentArgs: [] });
    expect(launched.kind).toBe("ok");
    if (launched.kind === "ok") {
      expect(launched.value.split(" ")).toContain("check_for_update_on_startup=false");
      expect(launched.value).toContain("-c check_for_update_on_startup=false");
    }
  });

  test("an unknown agent refuses command construction", () => {
    expect(commandLine("unregistered-agent", { model: "gpt-5", effort: "high", browser: false, agentArgs: [] })).toEqual({
      kind: "unknown",
      reason: "agent cannot be determined: unregistered-agent",
      error: "agent cannot be determined: unregistered-agent",
      exitCode: 1,
    });
  });

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
