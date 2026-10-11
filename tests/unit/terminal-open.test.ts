import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeTerminalDefault, executeTerminalOpen } from "../../src/cli/commands/terminal-open.js";
import { executeDoctor } from "../../src/cli/commands/install-doctor.js";
import { failed, ok } from "../../src/core/result.js";

type Call = { readonly command: string; readonly args: readonly string[]; readonly detached: boolean };

function fake(options: { readonly sessions?: readonly string[]; readonly present?: readonly string[] } = {}): ProcessAdapter & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const sessions = options.sessions ?? ["mb-session"];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args], detached: false });
      if (command === "tmux" && args.includes("has-session")) {
        const name = args[args.indexOf("-t") + 1] ?? "";
        return sessions.includes(name) ? ok({ stdout: "", stderr: "", exitCode: 0 }) : failed(`can't find session: ${name}`, 1);
      }
      if (command === "which") return (options.present ?? []).includes(args[0] ?? "") ? ok({ stdout: `/bin/${args[0]}\n`, stderr: "", exitCode: 0 }) : failed("not found", 1);
      return ok({ stdout: "42\n", stderr: "", exitCode: 0 });
    },
    async startDetached(command, args) {
      calls.push({ command, args: [...args], detached: true });
      return ok({ pid: 1 });
    },
    invocationCount: () => calls.length,
  };
}

const directories: string[] = [];
function state(): string {
  const directory = mkdtempSync(join(tmpdir(), "mb-terminal-open-"));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("terminal open", () => {
  test("opens the selected terminal attached to the session on a named server", async () => {
    const process = fake();
    const result = await executeTerminalOpen(["--session", "mb-session", "--server", "mb-x", "--terminal", "alacritty"], { MEGABRAIN_STATE_DIR: state() }, process);
    expect(result.kind).toBe("ok");
    expect(process.calls).toEqual([
      { command: "tmux", args: ["-L", "mb-x", "has-session", "-t", "mb-session"], detached: false },
      { command: "alacritty", args: ["-e", "tmux", "-L", "mb-x", "attach", "-t", "mb-session"], detached: true },
    ]);
    if (result.kind === "ok") expect(result.value).toContain("alacritty");
  });
  test("a terminal that returns is run, not detached", async () => {
    const process = fake();
    const result = await executeTerminalOpen(["--session", "mb-session", "--terminal", "terminal-app"], { MEGABRAIN_STATE_DIR: state() }, process, "darwin");
    expect(result.kind).toBe("ok");
    expect(process.calls[1]?.command).toBe("osascript");
    expect(process.calls[1]?.detached).toBe(false);
  });
  test("none prints the attach command and starts nothing", async () => {
    const process = fake();
    const result = await executeTerminalOpen(["--session", "mb-session", "--server", "mb-x", "--terminal", "none"], { MEGABRAIN_STATE_DIR: state() }, process);
    expect(result).toMatchObject({ kind: "ok" });
    if (result.kind === "ok") expect(result.value).toContain("tmux -L mb-x attach -t mb-session");
    expect(process.calls.some((call) => call.command !== "tmux")).toBe(false);
  });
  test("nothing detected behaves like none", async () => {
    const process = fake();
    const result = await executeTerminalOpen(["--session", "mb-session"], { MEGABRAIN_STATE_DIR: state() }, process);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value).toContain("tmux attach -t mb-session");
    expect(process.calls.every((call) => call.command === "tmux")).toBe(true);
  });
  test("detection from the environment picks the opener", async () => {
    const process = fake();
    await executeTerminalOpen(["--session", "mb-session"], { MEGABRAIN_STATE_DIR: state(), GNOME_TERMINAL_SCREEN: "x" }, process, "linux");
    expect(process.calls[1]?.command).toBe("gnome-terminal");
  });
  test("a missing session fails before any window opens", async () => {
    const process = fake({ sessions: [] });
    const result = await executeTerminalOpen(["--session", "ghost", "--terminal", "xterm"], { MEGABRAIN_STATE_DIR: state() }, process);
    expect(result.kind).toBe("failed");
    expect(process.calls.every((call) => call.command === "tmux")).toBe(true);
  });
  test("--session is required and unknown terminals fail", async () => {
    expect((await executeTerminalOpen([], { MEGABRAIN_STATE_DIR: state() }, fake())).kind).toBe("failed");
    expect((await executeTerminalOpen(["--session", "mb-session", "--terminal", "putty"], { MEGABRAIN_STATE_DIR: state() }, fake())).kind).toBe("failed");
  });
  test("uses the stored default when no flag or env is given", async () => {
    const directory = state();
    writeFileSync(join(directory, "terminal-default"), "konsole\n");
    const process = fake();
    await executeTerminalOpen(["--session", "mb-session"], { MEGABRAIN_STATE_DIR: directory }, process, "linux");
    expect(process.calls[1]?.command).toBe("konsole");
  });
  test("--json reports terminal, source and attach command", async () => {
    const result = await executeTerminalOpen(["--session", "mb-session", "--terminal", "xterm", "--json"], { MEGABRAIN_STATE_DIR: state() }, fake(), "linux");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ terminal: "xterm", source: "flag", session: "mb-session", attach: "tmux attach -t mb-session" });
  });
});

describe("terminal default", () => {
  test("reports unset, then stores, then clears", async () => {
    const directory = state();
    const environment = { MEGABRAIN_STATE_DIR: directory };
    const unset = await executeTerminalDefault([], environment);
    expect(unset.kind === "ok" && unset.value).toContain("unset");
    expect((await executeTerminalDefault(["kitty"], environment)).kind).toBe("ok");
    expect(readFileSync(join(directory, "terminal-default"), "utf8").trim()).toBe("kitty");
    const shown = await executeTerminalDefault([], environment);
    expect(shown.kind === "ok" && shown.value).toContain("kitty");
    expect(shown.kind === "ok" && shown.value).toContain(join(directory, "terminal-default"));
    expect((await executeTerminalDefault(["--clear"], environment)).kind).toBe("ok");
    expect(existsSync(join(directory, "terminal-default"))).toBe(false);
  });
  test("env takes precedence and is reported as the source", async () => {
    const directory = state();
    writeFileSync(join(directory, "terminal-default"), "kitty\n");
    const shown = await executeTerminalDefault([], { MEGABRAIN_STATE_DIR: directory, MEGABRAIN_TERMINAL: "xterm" });
    expect(shown.kind === "ok" && shown.value).toContain("xterm");
    expect(shown.kind === "ok" && shown.value).toContain("MEGABRAIN_TERMINAL");
  });
  test("rejects unknown names and accepts none and auto", async () => {
    const environment = { MEGABRAIN_STATE_DIR: state() };
    expect((await executeTerminalDefault(["putty"], environment)).kind).toBe("failed");
    expect((await executeTerminalDefault(["none"], environment)).kind).toBe("ok");
    expect((await executeTerminalDefault(["auto"], environment)).kind).toBe("ok");
  });
});

describe("doctor terminal-openers", () => {
  test("reports available, missing and unverified openers without failing when none exist", async () => {
    const directory = state();
    const environment = { HOME: directory, MEGABRAIN_STATE_DIR: join(directory, "state") };
    const result = await executeDoctor(["terminal-openers", "--json"], environment, fake({ present: ["xterm", "wezterm"] }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.value) as { module: string; status: string; reason: string };
    expect(value.module).toBe("terminal-openers");
    expect(value.status).toBe("ok");
    expect(value.reason).toMatch(/unverified/);
    expect(value.reason).toMatch(/missing/);
  });
});
