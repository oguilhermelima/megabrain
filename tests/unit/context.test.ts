import { describe, expect, test } from "bun:test";
import { resolveContext, resolveParentContext, type ContextEnvironment, type ContextProbes } from "../../src/core/context.js";

function environment(values: Partial<ContextEnvironment> = {}): ContextEnvironment {
  return values;
}

function probes(values: Partial<ContextProbes> = {}): ContextProbes {
  return { orcaWorktree: false, ...values };
}

describe("resolveContext", () => {
  test("resolves a Superset session and preserves context identities", () => {
    expect(resolveContext(environment({
      supersetTerminalId: "terminal",
      workspaceId: "workspace",
      agentId: "agent",
    }), probes())).toEqual({
      host: "superset",
      workspaceId: "workspace",
      terminalId: "terminal",
      agentId: "agent",
    });
  });

  test("resolves an Orca terminal session", () => {
    expect(resolveContext(environment({ orcaTerminalHandle: "orca-terminal" }), probes())).toEqual({
      host: "orca",
      workspaceId: null,
      terminalId: "orca-terminal",
      agentId: null,
    });
  });

  test("resolves a tmux session from the probe", () => {
    expect(resolveContext(environment({ tmux: "1", tmuxPane: "%4" }), probes({ tmuxSessionName: "work" }))).toEqual({
      host: "tmux",
      workspaceId: null,
      terminalId: "work:%4",
      agentId: null,
    });
  });

  test("resolves an Orca worktree probe when no terminal marker exists", () => {
    expect(resolveContext(environment(), probes({ orcaWorktree: true }))).toEqual({
      host: "orca",
      workspaceId: null,
      terminalId: null,
      agentId: null,
    });
  });

  test("returns unknown when no host can be determined", () => {
    expect(resolveContext(environment({ workspaceId: "workspace", agentId: "agent" }), probes())).toEqual({
      host: "unknown",
      workspaceId: "workspace",
      terminalId: null,
      agentId: "agent",
    });
  });

  test("uses documented precedence when multiple host markers are present", () => {
    expect(resolveContext(environment({
      supersetTerminalId: "superset-terminal",
      orcaTerminalHandle: "orca-terminal",
      tmux: "1",
      tmuxPane: "%4",
    }), probes({ tmuxSessionName: "work", orcaWorktree: true }))).toEqual({
      host: "superset",
      workspaceId: null,
      terminalId: "superset-terminal",
      agentId: null,
    });
  });
});

describe("resolveParentContext", () => {
  test.each([
    [{ supersetAgentId: "superset", supersetModel: "superset-model", supersetEffort: "low" }, { kind: "resolved", agent: "superset", model: "superset-model", effort: "low" }],
    [{ aiAgent: "claude-code_1-2-3_agent", aiModel: "model", aiEffort: "high" }, { kind: "resolved", agent: "claude", model: "model", effort: "high" }],
    [{ aiAgent: "not-a-known-agent" }, { kind: "unknown", reason: "unrecognised AI_AGENT descriptor", model: null, effort: null }],
    [{}, { kind: "unknown", reason: "no host identity was provided", model: null, effort: null }],
  ])("resolves parent context from %j", (input, expected) => {
    expect(resolveParentContext(input)).toEqual(expected);
  });

  test("uses AI fields to fill missing Superset fields", () => {
    expect(resolveParentContext({
      supersetAgentId: "superset",
      aiModel: "model",
      aiEffort: "high",
    })).toEqual({ kind: "resolved", agent: "superset", model: "model", effort: "high" });
  });

  test("recognizes a Codex session when only its session id is present", () => {
    expect(resolveParentContext({ codexSessionId: "session" })).toEqual({
      kind: "resolved", agent: "codex", model: null, effort: null,
    });
  });
});
