import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../../src/adapters/agent-command.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeAgent } from "../../src/cli/commands/agent.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import type { Chat } from "../../src/chat/store.js";
import { parseAgentSettings, parseStartCommand, startCommand } from "../../src/core/agent-settings.js";
import { failed, ok } from "../../src/core/result.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// `command -v <word>` succeeds for every word, so an override's first word is always found.
const found: ProcessAdapter = {
  run: async (_command, args) => ok({ stdout: `${(args.at(-1) ?? "").split(" ").at(-1) ?? ""}\n`, stderr: "", exitCode: 0 }),
  startDetached: async () => failed("a TUI is never started here"),
  invocationCount: () => 0,
};

function stateWith(commands: Record<string, string>): string {
  const state = mkdtempSync(join(tmpdir(), "megabrain-start-command-"));
  directories.push(state);
  writeFileSync(join(state, "agent-settings.json"), JSON.stringify({ version: 1, default: null, disabled: [], commands }));
  return state;
}

function chat(agent: Chat["agent"], extra: Partial<Chat> = {}): Chat {
  return { id: "11111111-1111-4111-8111-111111111111", agent, model: "m1", cwd: "/tmp", title: null, state: "idle", mode: "terminal", agentSessionId: "sess", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: null, ...extra };
}

describe("start command validation", () => {
  test("splits on whitespace and accepts the executable or an absolute path to it", () => {
    expect(parseStartCommand("codex", "  codex   --foo  -c x=1 ")).toEqual({ kind: "ok", value: ["codex", "--foo", "-c", "x=1"] });
    expect(parseStartCommand("claude", "/opt/bin/claude --verbose")).toEqual({ kind: "ok", value: ["/opt/bin/claude", "--verbose"] });
  });

  test("refuses an empty command, another executable, a relative path and quotes", () => {
    for (const [agent, text] of [["claude", ""], ["claude", "   "], ["claude", "codex --x"], ["claude", "bin/claude"], ["claude", "/opt/bin/claude-x"], ["codex", "codex -c 'a b'"], ["codex", 'codex "x"'], ["grok", "grok `id`"]] as const) {
      expect(parseStartCommand(agent, text).kind).toBe("failed");
    }
  });

  test("settings store an override per agent and refuse an invalid one", () => {
    const parsed = parseAgentSettings(JSON.stringify({ version: 1, default: null, disabled: [], commands: { codex: "codex --x" } }));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(startCommand(parsed.value, "codex")).toEqual(["codex", "--x"]);
      expect(startCommand(parsed.value, "claude")).toBeNull();
    }
    expect(parseAgentSettings(JSON.stringify({ version: 1, default: null, disabled: [], commands: { codex: "claude" } })).kind).toBe("failed");
    expect(parseAgentSettings(JSON.stringify({ version: 1, default: null, disabled: [], commands: { gemini: "gemini" } })).kind).toBe("failed");
    expect(parseAgentSettings(JSON.stringify({ version: 1, default: null, disabled: [], commands: { codex: 1 } })).kind).toBe("failed");
  });

  test("reset is the override removed: no commands key reads as the built-in command", () => {
    const parsed = parseAgentSettings(JSON.stringify({ version: 1, default: null, disabled: [] }));
    expect(parsed.kind === "ok" ? startCommand(parsed.value, "codex") : "bad").toBeNull();
  });
});

describe("agent command honours the override", () => {
  test("the override replaces executable, permission and startup; model, effort and resume are appended as before", async () => {
    expect(await agentCommand("codex", { base: ["/opt/codex", "--x"], model: "m1", effort: "low", resume: "s1" }, found)).toEqual(["/opt/codex", "resume", "s1", "--x", "-c", "model=m1", "-c", "model_reasoning_effort=low"]);
    expect(await agentCommand("claude", { base: ["claude", "--verbose"], resume: "s1" }, found)).toEqual(["claude", "--verbose", "--resume", "s1"]);
  });

  test("agent command reads the override from the state directory", async () => {
    const state = stateWith({ grok: "grok --y" });
    const result = await executeAgent(["command", "grok", "--model", "m1", "--json"], { MEGABRAIN_STATE_DIR: state }, found);
    expect(JSON.parse(result.kind === "ok" ? result.value : "null")).toEqual({ agent: "grok", argv: ["grok", "--y", "-m", "m1"], builtin: ["grok", "--always-approve"] });
    const plain = await executeAgent(["command", "claude", "--json"], { MEGABRAIN_STATE_DIR: state }, found);
    expect(JSON.parse(plain.kind === "ok" ? plain.value : "null")).toEqual({ agent: "claude", argv: ["claude", "--dangerously-skip-permissions"], builtin: ["claude", "--dangerously-skip-permissions"] });
  });
});

describe("chat terminal mode honours the override", () => {
  test("resume, model, effort and prompt are added around the override", () => {
    expect(chatProtocolAdapters.claude.terminalCommand(chat("claude", { effort: "high" }), "hi", ["/opt/claude", "--dangerously-skip-permissions", "--verbose"])).toEqual(["/opt/claude", "--resume", "sess", "--dangerously-skip-permissions", "--verbose", "--model", "m1", "--effort", "high", "hi"]);
    expect(chatProtocolAdapters.codex.terminalCommand(chat("codex"), undefined, ["codex", "--x"])).toEqual(["codex", "resume", "sess", "--x", "--model", "m1"]);
    expect(chatProtocolAdapters.grok.terminalCommand(chat("grok"), undefined, ["grok", "--y"])).toEqual(["grok", "--resume", "sess", "--y"]);
    expect(chatProtocolAdapters.agy.terminalCommand(chat("agy"), "go", ["agy", "--z"])).toEqual(["agy", "--conversation", "sess", "--z", "--model", "m1", "-i", "go"]);
  });

  test("with approvals on, the agent's own permission flags are removed from the override", () => {
    expect(chatProtocolAdapters.claude.terminalCommand(chat("claude", { approvals: true }), undefined, ["claude", "--dangerously-skip-permissions", "--verbose"])).toEqual(["claude", "--resume", "sess", "--verbose", "--model", "m1"]);
    expect(chatProtocolAdapters.codex.terminalCommand(chat("codex", { approvals: true }), undefined, ["codex", "--dangerously-bypass-approvals-and-sandbox", "--x"])).toEqual(["codex", "resume", "sess", "--x", "--model", "m1"]);
    expect(chatProtocolAdapters.grok.terminalCommand(chat("grok", { approvals: true }), undefined, ["grok", "--always-approve"])).toEqual(["grok", "--resume", "sess"]);
  });

  test("without an override the built-in command is unchanged", () => {
    expect(chatProtocolAdapters.codex.terminalCommand(chat("codex"))).toEqual(["codex", "resume", "sess", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false", "--model", "m1"]);
  });

});
