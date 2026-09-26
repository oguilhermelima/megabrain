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
      value: 'codex --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false -c disable_paste_burst=true -c model="gpt-5" -c model_reasoning_effort="high" -c mcp_servers.playwright.enabled=true',
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
      value: "codex --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false -c disable_paste_burst=true -c mcp_servers.playwright.enabled=false --extra-flag value",
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

  // Measured against real codex 0.155.1 in tmux: fast send-keys text followed immediately by
  // Enter is read as one paste burst, and the trailing Enter is absorbed into the paste instead
  // of submitting it, leaving the prompt sitting in the composer. Disabling paste-burst detection
  // at launch is what made an otherwise identical session submit and answer.
  test("codex launches with paste burst detection disabled", () => {
    const launched = commandLine("codex", { model: null, effort: null, browser: false, agentArgs: [] });
    expect(launched.kind).toBe("ok");
    if (launched.kind === "ok") {
      expect(launched.value.split(" ")).toContain("disable_paste_burst=true");
      expect(launched.value).toContain("-c disable_paste_burst=true");
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
    expect(submitKey("agy")).toEqual({ kind: "ok", value: "Enter" });
    expect(interruptKey("agy")).toEqual({ kind: "ok", value: "Escape" });
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

  test("an unrecognised agy screen is unknown rather than failed", () => {
    const agent = getAgent("agy");
    expect(agent).toBeDefined();
    const result = agent?.classifyLiveness("anything");
    expect(result?.kind).toBe("ok");
    if (result?.kind === "ok") expect(result.value).toEqual({ status: "unknown", reason: null });
    expect(classifyLiveness("agy", "anything")).toEqual({ status: "unknown", reason: null });
    expect(classifyLiveness("agy", "").status).toBe("unknown");
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
  });

  test("Claude recognizes its placeholder composer without treating typed text as idle", () => {
    expect(classifyLiveness("claude", "❯ Try \"fix typecheck errors\"").status).toBe("idle");
    expect(classifyLiveness("claude", "❯ fix the bug").status).toBe("unknown");
    expect(classifyLiveness("claude", "❯ Try \"fix typecheck errors\"\nWorking\nesc to interrupt").status).toBe("working");
  });

  // Captured verbatim from real Antigravity CLI 1.2.9 (gemini-3.8-flash-low) in an isolated tmux
  // pane: the composer box renders a bare "> " at the bottom whether the agent is idle or
  // generating, so idle cannot be told from the box alone — only the "Generating..." spinner line
  // above it distinguishes the two, and it must be checked first.
  const AGY_IDLE_SCREEN = [
    "────────────────────────────────────────────────────────────",
    "> say the word banana and nothing else",
    "",
    "  banana",
    "",
    "────────────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────────────",
    "Gemini 3.8 Flash (Low) 1M │ 22k/1M ctx │ 100% left │ 100% left",
  ].join("\n");

  const AGY_WORKING_SCREEN = [
    "────────────────────────────────────────────────────────────",
    "> count slowly from 1 to 50, one number per line, write out each number in",
    "  words too",
    "⣽  Generating...",
    "────────────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────────────",
    "Gemini 3.8 Flash (Low) 1M │ 22k/1M ctx │ 100% left │ 100% left",
  ].join("\n");

  test("agy liveness is read from the composer's Generating spinner, not the empty box", () => {
    expect(classifyLiveness("agy", AGY_IDLE_SCREEN)).toEqual({ status: "idle", reason: "terminal shows an empty Antigravity composer" });
    expect(classifyLiveness("agy", AGY_WORKING_SCREEN)).toEqual({ status: "working", reason: "terminal shows the Generating indicator" });
  });
});
