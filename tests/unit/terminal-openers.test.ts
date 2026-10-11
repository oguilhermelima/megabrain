import { describe, expect, test } from "bun:test";
import {
  appleScriptString,
  attachArgv,
  detectTerminal,
  OPENERS,
  openerInvocation,
  probeOpeners,
  selectTerminal,
  shellWords,
  type OpenerName,
} from "../../src/core/terminal-openers.js";

const attach = ["tmux", "-L", "mb-x", "attach", "-t", "mb session"];

describe("detectTerminal", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string>, OpenerName | undefined]> = [
    ["Terminal.app", { TERM_PROGRAM: "Apple_Terminal" }, "terminal-app"],
    ["iTerm2", { TERM_PROGRAM: "iTerm.app" }, "iterm2"],
    ["Ghostty", { TERM_PROGRAM: "ghostty" }, "ghostty"],
    ["WezTerm", { TERM_PROGRAM: "WezTerm" }, "wezterm"],
    ["kitty", { KITTY_WINDOW_ID: "4" }, "kitty"],
    ["Alacritty", { ALACRITTY_WINDOW_ID: "123" }, "alacritty"],
    ["gnome-terminal screen", { GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/x" }, "gnome-terminal"],
    ["VTE", { VTE_VERSION: "7603" }, "gnome-terminal"],
    ["Konsole beats VTE", { KONSOLE_VERSION: "230804", VTE_VERSION: "7603" }, "konsole"],
    ["Windows Terminal", { WT_SESSION: "abc" }, "windows-terminal"],
    ["VS Code is not an opener", { TERM_PROGRAM: "vscode" }, undefined],
    ["tmux falls through to other variables", { TERM_PROGRAM: "tmux", KITTY_WINDOW_ID: "1" }, "kitty"],
    ["nothing", {}, undefined],
  ];
  for (const [label, env, expected] of cases) {
    test(label, () => expect(detectTerminal(env)).toBe(expected));
  }
});

describe("selectTerminal", () => {
  const detected = { TERM_PROGRAM: "iTerm.app" };
  test("flag beats env, stored value and detection", () => {
    expect(selectTerminal({ flag: "kitty", env: { ...detected, MEGABRAIN_TERMINAL: "xterm" }, stored: "alacritty" }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "kitty", source: "flag" } });
  });
  test("env beats stored value and detection", () => {
    expect(selectTerminal({ env: { ...detected, MEGABRAIN_TERMINAL: "xterm" }, stored: "alacritty" }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "xterm", source: "env" } });
  });
  test("stored value beats detection", () => {
    expect(selectTerminal({ env: detected, stored: "alacritty" }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "alacritty", source: "stored" } });
  });
  test("detection is used last", () => {
    expect(selectTerminal({ env: detected }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "iterm2", source: "detected" } });
  });
  test("none when nothing is set or detected", () => {
    expect(selectTerminal({ env: {} })).toEqual({ kind: "ok", value: { kind: "none", source: "undetected" } });
  });
  test("none from the flag wins over everything", () => {
    expect(selectTerminal({ flag: "none", env: detected, stored: "kitty" }))
      .toEqual({ kind: "ok", value: { kind: "none", source: "flag" } });
  });
  test("auto skips env and stored value and detects", () => {
    expect(selectTerminal({ flag: "auto", env: { ...detected, MEGABRAIN_TERMINAL: "xterm" }, stored: "kitty" }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "iterm2", source: "detected" } });
  });
  test("auto in the stored value falls to detection", () => {
    expect(selectTerminal({ env: detected, stored: "auto" }))
      .toEqual({ kind: "ok", value: { kind: "opener", name: "iterm2", source: "detected" } });
  });
  test("unknown names fail and list the valid ones", () => {
    const result = selectTerminal({ flag: "putty", env: {} });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toContain("putty");
      for (const opener of OPENERS) expect(result.error).toContain(opener.name);
    }
  });
  test("unknown name in env fails", () => {
    expect(selectTerminal({ env: { MEGABRAIN_TERMINAL: "putty" } }).kind).toBe("failed");
  });
});

describe("quoting", () => {
  test("shellWords single-quotes every word", () => {
    expect(shellWords(["tmux", "attach", "-t", "it's a name"])).toBe("'tmux' 'attach' '-t' 'it'\\''s a name'");
  });
  test("appleScriptString escapes backslashes and double quotes", () => {
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  test("attachArgv names the server only when given", () => {
    expect(attachArgv("s")).toEqual(["tmux", "attach", "-t", "s"]);
    expect(attachArgv("s", "mb-x")).toEqual(["tmux", "-L", "mb-x", "attach", "-t", "s"]);
  });
});

describe("openerInvocation", () => {
  const darwin = { env: {}, platform: "darwin" } as const;
  const linux = { env: {}, platform: "linux" } as const;

  test("Terminal.app runs a quoted do script through osascript", () => {
    const invocation = openerInvocation("terminal-app", ['tmux', '-L', 'mb-x', 'attach', '-t', 'say "hi" there'], darwin);
    expect(invocation.command).toBe("osascript");
    expect(invocation.detached).toBe(false);
    const script = invocation.args.filter((_, index) => index % 2 === 1).join("\n");
    expect(invocation.args.filter((_, index) => index % 2 === 0).every((flag) => flag === "-e")).toBe(true);
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain('do script "\'tmux\' \'-L\' \'mb-x\' \'attach\' \'-t\' \'say \\"hi\\" there\'"');
  });
  test("iTerm2 creates a window with the quoted command", () => {
    const invocation = openerInvocation("iterm2", attach, darwin);
    expect(invocation.command).toBe("osascript");
    const script = invocation.args.filter((_, index) => index % 2 === 1).join("\n");
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain('create window with default profile command "\'tmux\' \'-L\' \'mb-x\' \'attach\' \'-t\' \'mb session\'"');
  });
  test("AppleScript injection through a session name stays inside the string", () => {
    const hostile = ['tmux', 'attach', '-t', '" & (do shell script "touch /tmp/pwned") & "'];
    const script = openerInvocation("terminal-app", hostile, darwin).args.filter((_, index) => index % 2 === 1).join("\n");
    const line = script.split("\n").find((candidate) => candidate.startsWith("do script ")) ?? "";
    const body = line.slice("do script ".length);
    // Only the two delimiting quotes may be unescaped.
    expect(body.match(/(?<!\\)"/g)?.length).toBe(2);
    expect(body.startsWith('"') && body.endsWith('"')).toBe(true);
  });
  test("Ghostty uses open -na on macOS and the binary on Linux", () => {
    expect(openerInvocation("ghostty", attach, darwin)).toEqual({ command: "open", args: ["-na", "Ghostty", "--args", "-e", ...attach], detached: false });
    expect(openerInvocation("ghostty", attach, linux)).toEqual({ command: "ghostty", args: ["-e", ...attach], detached: true });
  });
  test("WezTerm spawns in the running instance, else starts one", () => {
    expect(openerInvocation("wezterm", attach, { env: { WEZTERM_PANE: "3" }, platform: "linux" }))
      .toEqual({ command: "wezterm", args: ["cli", "spawn", "--new-window", "--", ...attach], detached: false });
    expect(openerInvocation("wezterm", attach, linux))
      .toEqual({ command: "wezterm", args: ["start", "--", ...attach], detached: true });
  });
  test("kitty uses remote control when enabled, else starts a window", () => {
    expect(openerInvocation("kitty", attach, { env: { KITTY_LISTEN_ON: "unix:/tmp/k" }, platform: "linux" }))
      .toEqual({ command: "kitten", args: ["@", "launch", "--type=os-window", ...attach], detached: false });
    expect(openerInvocation("kitty", attach, linux))
      .toEqual({ command: "kitty", args: [...attach], detached: true });
  });
  test("terminals that take -e or -- pass argv untouched", () => {
    expect(openerInvocation("alacritty", attach, linux)).toEqual({ command: "alacritty", args: ["-e", ...attach], detached: true });
    expect(openerInvocation("gnome-terminal", attach, linux)).toEqual({ command: "gnome-terminal", args: ["--", ...attach], detached: true });
    expect(openerInvocation("konsole", attach, linux)).toEqual({ command: "konsole", args: ["-e", ...attach], detached: true });
    expect(openerInvocation("xterm", attach, linux)).toEqual({ command: "xterm", args: ["-e", ...attach], detached: true });
    expect(openerInvocation("windows-terminal", attach, linux)).toEqual({ command: "wt.exe", args: ["-w", "new", "new-tab", ...attach], detached: true });
  });
});

describe("probeOpeners", () => {
  test("reports binaries and app bundles per platform, and which openers were verified", async () => {
    const found = new Set(["wezterm", "/Applications/Utilities/Terminal.app"]);
    const probes = await probeOpeners({
      platform: "darwin",
      home: "/Users/x",
      which: async (command) => found.has(command),
      exists: (path) => found.has(path),
    });
    const byName = Object.fromEntries(probes.map((probe) => [probe.name, probe]));
    expect(byName["terminal-app"]).toMatchObject({ available: true, verified: true });
    expect(byName["wezterm"]).toMatchObject({ available: true, verified: false });
    expect(byName["iterm2"]).toMatchObject({ available: false });
    expect(byName["gnome-terminal"]).toBeUndefined();
    expect(byName["konsole"]).toBeUndefined();
  });
  test("linux lists linux openers only", async () => {
    const probes = await probeOpeners({ platform: "linux", home: "/h", which: async (command) => command === "xterm", exists: () => false });
    expect(probes.find((probe) => probe.name === "xterm")).toMatchObject({ available: true });
    expect(probes.find((probe) => probe.name === "terminal-app")).toBeUndefined();
  });
});
