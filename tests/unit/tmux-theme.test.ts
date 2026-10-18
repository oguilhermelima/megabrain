import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeTmux } from "../../src/cli/commands/tmux.js";
import { failed, ok } from "../../src/core/result.js";

const root = process.cwd();
const tuning = readFileSync(join(root, "tmux/megabrain.tmux.conf"), "utf8");
const oldProfile = "set -g pane-border-status top\nset -g pane-border-format '#{pane_title}'\n";

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
  test("uses plain panes while keeping agent identity in pane and terminal titles", () => {
    expect(tuning).toMatch(/^set -g pane-border-status off$/m);
    expect(tuning).not.toMatch(/^set -g pane-border-format /m);
    expect(tuning).toContain("set -g set-titles on");
    expect(tuning).toContain("set -g set-titles-string '#{pane_title}'");
  });

  test("uses terminal defaults and ANSI colours without badge colours", () => {
    expect(tuning).toContain("default");
    expect(tuning).toContain("brightblack");
    expect(tuning.match(/#[0-9a-f]{6}/gi)).toBeNull();
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

  test("replaces an installed old profile in place and tune stays idempotent", async () => {
    const home = mkdtempSync(join(tmpdir(), "megabrain-tmux-theme-upgrade-"));
    const installed = join(home, ".megabrain/tmux/megabrain.tmux.conf");
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(home, ".megabrain/tmux"), { recursive: true }));
      writeFileSync(installed, oldProfile);
      const first = await executeTmux(["tune", "--yes"], { HOME: home, MEGABRAIN_ROOT: root }, processFor());
      expect(first.kind).toBe("ok");
      const updated = readFileSync(installed, "utf8");
      expect(updated).toContain("set -g pane-border-status off");
      expect(updated).not.toContain("pane-border-format");
      const config = readFileSync(join(home, ".tmux.conf"), "utf8");
      const second = await executeTmux(["tune", "--yes"], { HOME: home, MEGABRAIN_ROOT: root }, processFor());
      expect(second.kind).toBe("ok");
      expect(readFileSync(installed, "utf8")).toBe(updated);
      expect(readFileSync(join(home, ".tmux.conf"), "utf8")).toBe(config);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
