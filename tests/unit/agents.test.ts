import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolveParentContext } from "../../src/core/context.js";
import { classifyLiveness, isFirstRunDialog } from "../../src/core/liveness.js";
import { commandLine, getAgent, interruptKey, registerAgent, submitKey, unregisterAgent, type Agent } from "../../src/agents/index.js";
import { ok, type Result } from "../../src/core/result.js";
import { agentReadyTimeoutMs } from "../../src/cli/commands/orchestrate-spawn-options.js";

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
    // agy lists one id per level; a model the registry folded runs as the id for the level picked.
    expect(commandLine("agy", { model: "gemini-4-argon", effort: "high", browser: true, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'agy --dangerously-skip-permissions --model "gemini-4-argon-high"',
    });
    expect(commandLine("agy", { model: "claude-sonnet-4-6", effort: "none", browser: true, agentArgs: [] })).toEqual({
      kind: "ok",
      value: 'agy --dangerously-skip-permissions --model "claude-sonnet-4-6"',
    });
  });

  test("a Claude child always launches in bypass: no --agent-arg may change its permission mode", () => {
    for (const agentArgs of [["--permission-mode", "plan"], ["--permission-mode=default"], ["--permission-mode", "bypassPermissions"]]) {
      const line = commandLine("claude", { model: null, effort: null, browser: false, agentArgs });
      expect(line.kind).toBe("failed");
      expect(line.kind === "ok" ? "" : line.error).toContain("--permission-mode");
    }
    expect(commandLine("claude", { model: null, effort: null, browser: false, agentArgs: ["--add-dir", "/tmp/x"] })).toEqual({
      kind: "ok",
      value: "claude --dangerously-skip-permissions --add-dir /tmp/x",
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
    expect(interruptKey("grok")).toEqual({ kind: "ok", value: "C-c" });
    expect(interruptKey("agy").kind).toBe("unknown");
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

  test("Claude fullscreen and classic captures both prove an idle composer", async () => {
    const fullscreen = await readFile(new URL("../fixtures/claude-fullscreen-composer.txt", import.meta.url), "utf8");
    const classicCapture = JSON.parse(await readFile(new URL("../fixtures/orca-terminal-screen-claude-idle.json", import.meta.url), "utf8")) as { result: { terminal: { tail: string[] } } };
    expect(classifyLiveness("claude", fullscreen).status).toBe("idle");
    expect(classifyLiveness("claude", classicCapture.result.terminal.tail.join("\n")).status).toBe("idle");
  });

  test("Codex is not ready while its header or MCP servers are still loading", async () => {
    const loadingHeader = await readFile(new URL("../fixtures/codex-loading-header.txt", import.meta.url), "utf8");
    const mcpStartup = await readFile(new URL("../fixtures/tmux-capture-codex-argv-brief.txt", import.meta.url), "utf8");
    expect(classifyLiveness("codex", loadingHeader).status).not.toBe("idle");
    expect(classifyLiveness("codex", mcpStartup).status).not.toBe("idle");
  });

  test("spawn readiness uses a bounded launch budget for each agent and keeps the override", () => {
    // Claude's first fullscreen frame can exceed the old 10 s window; Codex follows Orca's
    // 20 s composer budget including MCP startup. Grok's intro can animate for 10 s, and agy
    // performs a first-launch workspace setup before painting its composer.
    const expected = { claude: 30000, codex: 20000, grok: 20000, agy: 20000 } as const;
    for (const [agent, timeout] of Object.entries(expected)) {
      expect(agentReadyTimeoutMs({}, agent)).toBe(timeout);
      expect(agentReadyTimeoutMs({ MEGABRAIN_AGENT_READY_TIMEOUT_MS: "2345" }, agent)).toBe(2345);
    }
  });

  test("agy classifies captured trust, idle, and working screens", async () => {
    const screen = async (name: string) => {
      const capture = JSON.parse(await readFile(new URL(`../fixtures/orca-terminal-screen-agy-${name}.json`, import.meta.url), "utf8")) as { result: { terminal: { tail: string[] } } };
      return capture.result.terminal.tail.join("\n");
    };
    const trust = await screen("trust");
    expect(classifyLiveness("agy", trust).status).toBe("unknown");
    expect(isFirstRunDialog("agy", trust)).toBe(true);
    expect(classifyLiveness("agy", await screen("idle")).status).toBe("idle");
    for (const name of ["working-1", "working-2", "working-3"]) {
      const captured = await screen(name);
      if (captured.includes("Generating")) expect(classifyLiveness("agy", captured).status).toBe("working");
    }
  });

  test("agy recognises the trust dialog in a real tmux capture and the Orca capture", async () => {
    const tmuxTrust = await readFile(new URL("../fixtures/tmux-capture-agy-trust.txt", import.meta.url), "utf8");
    const orcaCapture = JSON.parse(await readFile(new URL("../fixtures/orca-terminal-screen-agy-trust.json", import.meta.url), "utf8")) as { result: { terminal: { tail: string[] } } };

    expect(isFirstRunDialog("agy", tmuxTrust)).toBe(true);
    expect(isFirstRunDialog("agy", orcaCapture.result.terminal.tail.join("\n"))).toBe(true);
  });

  test("agy only declares the exact preselected trust dialog", async () => {
    const capture = JSON.parse(await readFile(new URL("../fixtures/orca-terminal-screen-agy-trust.json", import.meta.url), "utf8")) as { result: { terminal: { tail: string[] } } };
    const trust = capture.result.terminal.tail.join("\n");
    expect(isFirstRunDialog("agy", trust.replace("> Yes, I trust this folder", "> No, exit"))).toBe(false);
    expect(isFirstRunDialog("agy", "Do you trust the contents of this project?\n> Yes, I trust this folder")).toBe(false);
  });
});
