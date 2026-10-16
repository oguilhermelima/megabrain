import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeAgent } from "../../src/cli/commands/agent.js";
import { readAgentDefaults } from "../../src/core/agent-defaults.js";
import { failed } from "../../src/core/result.js";

const homes: string[] = [];

function home(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "megabrain-agent-defaults-"));
  homes.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

const noProcess: ProcessAdapter = {
  run: async () => failed("no process runs here"),
  startDetached: async () => failed("no process runs here"),
  invocationCount: () => 0,
};

describe("agent defaults", () => {
  test("each agent's default model and effort come from its own config", async () => {
    const root = home({
      ".claude/settings.json": JSON.stringify({ model: "opus", effortLevel: "high", theme: "dark" }),
      ".codex/config.toml": 'model = "gpt-6-luna" # the daily one\nmodel_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel = "gpt-6-mini"\n',
      ".grok/config.toml": '[ui]\ndefault = "not a model"\n\n[models]\ndefault = "grok-4.7"\ndefault_reasoning_effort = "low"\n',
      ".gemini/antigravity-cli/settings.json": JSON.stringify({ model: "Gemini 3.8 Flash (Medium)" }),
    });
    const report = await readAgentDefaults({ HOME: root, SHELL: "/bin/zsh" });
    expect(report).toEqual({
      agents: [
        { agent: "claude", model: "opus", effort: "high" },
        { agent: "codex", model: "gpt-6-luna", effort: "medium" },
        { agent: "grok", model: "grok-4.7", effort: "low" },
        { agent: "agy", model: "Gemini 3.8 Flash", effort: "medium" },
      ],
      shell: "zsh",
    });
  });

  test("a codex profile chosen in the config overrides the top-level keys it sets", async () => {
    const root = home({ ".codex/config.toml": "profile = 'fast'\nmodel = \"gpt-6-luna\"\nmodel_reasoning_effort = \"high\"\n[profiles.fast]\nmodel = \"gpt-6-mini\"\n" });
    const report = await readAgentDefaults({ HOME: root });
    expect(report.agents.find((entry) => entry.agent === "codex")).toEqual({ agent: "codex", model: "gpt-6-mini", effort: "high" });
  });

  test("CLAUDE_CONFIG_DIR, CODEX_HOME and GROK_HOME move where each config is read", async () => {
    const root = home({
      "c/settings.json": JSON.stringify({ model: "sonnet" }),
      "x/config.toml": 'model = "gpt-6"\n',
      "g/config.toml": '[models]\ndefault = "grok-5"\n',
    });
    const report = await readAgentDefaults({ HOME: join(root, "nowhere"), CLAUDE_CONFIG_DIR: join(root, "c"), CODEX_HOME: join(root, "x"), GROK_HOME: join(root, "g") });
    expect(report.agents.slice(0, 3)).toEqual([
      { agent: "claude", model: "sonnet", effort: null },
      { agent: "codex", model: "gpt-6", effort: null },
      { agent: "grok", model: "grok-5", effort: null },
    ]);
  });

  test("a missing, unreadable or malformed config reports no default, never fails", async () => {
    const root = home({
      ".claude/settings.json": "{ not json",
      ".codex/config.toml": "model = \n",
      ".gemini/antigravity-cli/settings.json": JSON.stringify({ model: 42 }),
    });
    const report = await readAgentDefaults({ HOME: root });
    expect(report.agents).toEqual([
      { agent: "claude", model: null, effort: null },
      { agent: "codex", model: null, effort: null },
      { agent: "grok", model: null, effort: null },
      { agent: "agy", model: null, effort: null },
    ]);
  });

  test("the shell is the one a new terminal opens: SHELL's name, else sh", async () => {
    const root = home({});
    expect((await readAgentDefaults({ HOME: root, SHELL: "/opt/homebrew/bin/fish" })).shell).toBe("fish");
    expect((await readAgentDefaults({ HOME: root })).shell).toBe("sh");
    expect((await readAgentDefaults({ HOME: root, SHELL: "" })).shell).toBe("sh");
  });

  test("megabrain agent defaults --json prints the report and the text form names each default", async () => {
    const root = home({ ".codex/config.toml": 'model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n' });
    const json = await executeAgent(["defaults", "--json"], { HOME: root, SHELL: "/bin/bash" }, noProcess);
    expect(json.kind).toBe("ok");
    if (json.kind !== "ok") return;
    expect(JSON.parse(json.value)).toEqual({
      agents: [
        { agent: "claude", model: null, effort: null },
        { agent: "codex", model: "gpt-6-luna", effort: "medium" },
        { agent: "grok", model: null, effort: null },
        { agent: "agy", model: null, effort: null },
      ],
      shell: "bash",
    });
    const text = await executeAgent(["defaults"], { HOME: root, SHELL: "/bin/bash" }, noProcess);
    expect(text).toEqual({ kind: "ok", value: "claude: agent default\ncodex: gpt-6-luna · medium\ngrok: agent default\nagy: agent default\nshell: bash\n" });
  });

  test("an unknown option is refused with the usage line", async () => {
    const result = await executeAgent(["defaults", "--yaml"], { HOME: "/nowhere" }, noProcess);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("Usage: megabrain agent defaults [--json]");
  });
});
