import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommands } from "../../src/cli/commands/commands.js";
import { infoLimitsForAgent, renderInfoCommand } from "../../src/chat/daemon/info-command.js";

describe("native chat info commands", () => {
  test("the command menu includes info commands for both supported chat agents", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-chat-menu-"));
    try {
      mkdirSync(join(root, "project"));
      for (const agent of ["claude", "codex"]) {
        const result = await executeCommands(["--agent", agent, "--cwd", join(root, "project"), "--json"], { HOME: root });
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
          const entries = JSON.parse(result.value) as Array<{ name: string }>;
          for (const command of ["status", "usage", "context"]) expect(entries.some((entry) => entry.name === command)).toBe(true);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Codex info contains known chat state and rollout limits only", () => {
    const data = infoLimitsForAgent("codex", [
      { label: "5h", usedPercent: 42, resetsAt: "4102444800", window: "5h" },
    ]);
    const rendered = renderInfoCommand("/status", {
      model: "gpt-5-codex", effort: "high", approvals: true, sandbox: "workspace-write", cwd: "/work/project",
      context: { used: 63729, window: 258400, percent: 24.7 }, limits: data,
    });
    expect(data).toEqual([{ label: "5h", usedPercent: 42, resetsAt: "4102444800", window: "5h" }]);
    expect(rendered).toContain("gpt-5-codex");
    expect(rendered).toContain("63,729 / 258,400");
    expect(rendered).toContain("42%");
  });

  test("Grok and agy limit builders preserve their own measured rows", () => {
    const row = { label: "weekly", usedPercent: 61, resetsAt: "4102444800", window: "weekly" as const };
    expect(infoLimitsForAgent("grok", [row])).toEqual([row]);
    expect(infoLimitsForAgent("agy", [row])).toEqual([row]);
  });

  test("missing readings stay absent from the info data and rendering", () => {
    const data = infoLimitsForAgent("codex", []);
    const rendered = renderInfoCommand("/usage", { model: "gpt-5-codex", tokens: { input: 10, output: 3 } });
    expect(data).toEqual([]);
    expect(rendered).not.toContain("Limits");
    expect(rendered).not.toContain("context");
  });
});
