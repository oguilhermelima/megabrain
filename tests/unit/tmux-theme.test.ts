import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeTmux } from "../../src/cli/commands/tmux.js";
import { failed, ok } from "../../src/core/result.js";

const root = process.cwd();
const tuning = readFileSync(join(root, "tmux/megabrain.tmux.conf"), "utf8");
const approvedFormat = "#{?#{==:#{?@megabrain_agent,#{@megabrain_agent},#{?#{m/r:^[0-9]+[.][0-9.]+$,#{pane_current_command}},claude,#{pane_current_command}}},codex},#[bg=white fg=black],#{?#{==:#{?@megabrain_agent,#{@megabrain_agent},#{?#{m/r:^[0-9]+[.][0-9.]+$,#{pane_current_command}},claude,#{pane_current_command}}},claude},#[bg=#d97757 fg=white],#{?#{==:#{?@megabrain_agent,#{@megabrain_agent},#{?#{m/r:^[0-9]+[.][0-9.]+$,#{pane_current_command}},claude,#{pane_current_command}}},agy},#[bg=blue fg=white],#[fg=brightblack]}}} #{?@megabrain_agent,#{@megabrain_agent},#{?#{m/r:^[0-9]+[.][0-9.]+$,#{pane_current_command}},claude,#{pane_current_command}}} #[default] #{?pane_active,#[fg=default bold],#[fg=brightblack]}#{?@megabrain_name,#{@megabrain_name},#{pane_title}}#[default]#{?@megabrain_state, #{?#{==:#{@megabrain_state},working},#[fg=blue]●,#{?#{==:#{@megabrain_state},question},#[fg=yellow]?,#{?#{==:#{@megabrain_state},finished},#[fg=green]✓,#{?#{==:#{@megabrain_state},stuck},#[fg=red]!,#[fg=brightblack]○}}}}#[default],} ";

function paneBorderFormat(): string {
  const line = tuning.split("\n").find((candidate) => candidate.startsWith("set -g pane-border-format "));
  if (line === undefined) throw new Error("pane-border-format is missing from the shipped theme");
  return line.slice("set -g pane-border-format '".length, -1);
}

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
  test("specifies the approved agent badge colours and command fallback", () => {
    const format = paneBorderFormat();
    expect(format).toBe(approvedFormat);
    expect(format).toContain("},codex},#[bg=white fg=black]");
    expect(format).toContain("},claude},#[bg=#d97757 fg=white]");
    expect(format).toContain("},agy},#[bg=blue fg=white]");
    expect(format).toContain("#[fg=brightblack]}}");
    expect(format).toContain("#{?#{m/r:^[0-9]+[.][0-9.]+$,#{pane_current_command}},claude,#{pane_current_command}}");
    expect(format.match(/#[0-9a-f]{6}/gi)).toEqual(["#d97757"]);
  });

  test("dims inactive titles and only shows state glyphs when state is set", () => {
    const format = paneBorderFormat();
    expect(format).toContain("#{?pane_active,#[fg=default bold],#[fg=brightblack]}");
    expect(format).toContain("#{?@megabrain_state, ");
    for (const glyph of ["●", "?", "✓", "!", "○"]) expect(format).toContain(glyph);
  });

  test("uses terminal defaults, ANSI colours, and only the approved hex colour", () => {
    expect(tuning).toContain("default");
    expect(tuning).toContain("brightblack");
    expect(tuning.match(/#[0-9a-f]{6}/gi)).toEqual(["#d97757"]);
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
