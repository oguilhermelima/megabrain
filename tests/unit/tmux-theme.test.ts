import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeTmux } from "../../src/cli/commands/tmux.js";
import { failed, ok } from "../../src/core/result.js";

const root = process.cwd();
const tuning = readFileSync(join(root, "tmux/megabrain.tmux.conf"), "utf8");

function processFor(): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "date") return ok({ stdout: "20261011T000000Z\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && args[0] === "list-sessions") return failed("no server");
      return failed("unexpected process call");
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

describe("native tmux theme", () => {
  test("reads pane identity options with command and title fallbacks and state glyphs", () => {
    expect(tuning).toContain("#{@megabrain_agent}");
    expect(tuning).toContain("#{pane_current_command}");
    expect(tuning).toContain("#{@megabrain_name}");
    expect(tuning).toContain("#{pane_title}");
    expect(tuning).toContain("@megabrain_state");
    expect(tuning).toContain("●");
    expect(tuning).toContain("?");
    expect(tuning).toContain("✓");
    expect(tuning).toContain("!");
    expect(tuning).toContain("○");
    expect(tuning).toContain("pane-border-format");
  });

  test("uses terminal defaults and ANSI colours without a green status fill or RGB values", () => {
    expect(tuning).toContain("default");
    expect(tuning).toContain("brightblack");
    expect(tuning).not.toMatch(/#[0-9a-f]{6}/i);
    expect(tuning).not.toMatch(/\bcolour(?:2|10)\b/);
    expect(tuning).not.toMatch(/status-style[^\n]*bg=green/);
    expect(tuning).toContain("status off");
    expect(tuning).toContain("session_windows");
  });

  test("dry-run leaves the temp home unchanged and reports the tuning file", async () => {
    const home = mkdtempSync(join(tmpdir(), "megabrain-tmux-theme-dry-"));
    try {
      const result = await executeTmux(["tune", "--dry-run", "--json"], { HOME: home, MEGABRAIN_ROOT: root }, processFor());
      expect(result.kind).toBe("ok");
      expect(result.kind === "ok" ? result.value : "").toContain('"action": "dry-run"');
      expect(existsSync(join(home, ".tmux.conf"))).toBe(false);
      expect(existsSync(join(home, ".megabrain/tmux/megabrain.tmux.conf"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("revert removes only the managed source block and restores the prior config look", async () => {
    const home = mkdtempSync(join(tmpdir(), "megabrain-tmux-theme-revert-"));
    const previous = "# operator config\nset -g status on\n";
    try {
      writeFileSync(join(home, ".tmux.conf"), `${previous}# >>> megabrain tmux tuning >>>\nsource-file ~/.megabrain/tmux/megabrain.tmux.conf\n# <<< megabrain tmux tuning <<<\n`);
      const result = await executeTmux(["tune", "--revert", "--json"], { HOME: home, MEGABRAIN_ROOT: root }, processFor());
      expect(result.kind).toBe("ok");
      expect(readFileSync(join(home, ".tmux.conf"), "utf8")).toBe(previous);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
