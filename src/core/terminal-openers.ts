import { failed, ok, type Result } from "./result.js";

export type Environment = Readonly<Record<string, string | undefined>>;
export type Platform = "darwin" | "linux" | "win32";

export const OPENER_NAMES = [
  "terminal-app", "iterm2", "ghostty", "wezterm", "kitty", "alacritty",
  "gnome-terminal", "konsole", "xterm", "windows-terminal",
] as const;
export type OpenerName = (typeof OPENER_NAMES)[number];

export type OpenerInfo = Readonly<{
  name: OpenerName;
  label: string;
  platforms: readonly Platform[];
  // The binary names that prove the terminal is installed, and the macOS app bundles that do.
  binaries: readonly string[];
  bundles: readonly string[];
  // True only for openers whose window was opened and inspected on a real machine.
  verified: boolean;
}>;

export const OPENERS: readonly OpenerInfo[] = [
  { name: "terminal-app", label: "Terminal.app", platforms: ["darwin"], binaries: [], bundles: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"], verified: true },
  { name: "iterm2", label: "iTerm2", platforms: ["darwin"], binaries: [], bundles: ["/Applications/iTerm.app"], verified: false },
  { name: "ghostty", label: "Ghostty", platforms: ["darwin", "linux"], binaries: ["ghostty"], bundles: ["/Applications/Ghostty.app"], verified: false },
  { name: "wezterm", label: "WezTerm", platforms: ["darwin", "linux", "win32"], binaries: ["wezterm"], bundles: ["/Applications/WezTerm.app"], verified: false },
  { name: "kitty", label: "kitty", platforms: ["darwin", "linux"], binaries: ["kitty"], bundles: ["/Applications/kitty.app"], verified: false },
  { name: "alacritty", label: "Alacritty", platforms: ["darwin", "linux", "win32"], binaries: ["alacritty"], bundles: ["/Applications/Alacritty.app"], verified: false },
  { name: "gnome-terminal", label: "gnome-terminal", platforms: ["linux"], binaries: ["gnome-terminal"], bundles: [], verified: false },
  { name: "konsole", label: "Konsole", platforms: ["linux"], binaries: ["konsole"], bundles: [], verified: false },
  { name: "xterm", label: "xterm", platforms: ["linux"], binaries: ["xterm"], bundles: [], verified: false },
  { name: "windows-terminal", label: "Windows Terminal", platforms: ["linux", "win32"], binaries: ["wt.exe"], bundles: [], verified: false },
];

export function isOpenerName(value: string): value is OpenerName {
  return (OPENER_NAMES as readonly string[]).includes(value);
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

// Each variable is documented by its terminal: TERM_PROGRAM by Terminal.app, iTerm2, Ghostty and
// WezTerm; KITTY_WINDOW_ID by kitty; ALACRITTY_WINDOW_ID by Alacritty; KONSOLE_VERSION by Konsole;
// GNOME_TERMINAL_SCREEN and VTE_VERSION by gnome-terminal/VTE; WT_SESSION by Windows Terminal.
// VS Code sets TERM_PROGRAM=vscode, but its integrated terminal cannot open a separate window.
export function detectTerminal(env: Environment): OpenerName | undefined {
  switch (env.TERM_PROGRAM) {
    case "Apple_Terminal": return "terminal-app";
    case "iTerm.app": return "iterm2";
    case "ghostty": return "ghostty";
    case "WezTerm": return "wezterm";
    default: break;
  }
  if (nonEmpty(env.KITTY_WINDOW_ID)) return "kitty";
  if (nonEmpty(env.ALACRITTY_WINDOW_ID)) return "alacritty";
  if (nonEmpty(env.KONSOLE_VERSION)) return "konsole";
  if (nonEmpty(env.GNOME_TERMINAL_SCREEN) || nonEmpty(env.VTE_VERSION)) return "gnome-terminal";
  if (nonEmpty(env.WT_SESSION)) return "windows-terminal";
  return undefined;
}

export type Selection =
  | Readonly<{ kind: "opener"; name: OpenerName; source: "flag" | "env" | "stored" | "detected" }>
  | Readonly<{ kind: "none"; source: "flag" | "env" | "stored" | "undetected" }>;

type Choice = Result<OpenerName | "none" | "auto">;

function choice(value: string, origin: string): Choice {
  const normalized = value.trim();
  if (normalized === "none" || normalized === "auto" || isOpenerName(normalized)) return ok(normalized);
  return failed(`unknown terminal '${normalized}' (${origin}); use one of: ${OPENER_NAMES.join(", ")}, auto, none`, 2);
}

// Precedence: --terminal flag, MEGABRAIN_TERMINAL, the stored default, then detection, then none.
// "auto" at any level means detect, skipping the lower explicit levels.
export function selectTerminal(input: Readonly<{ flag?: string; env: Environment; stored?: string }>): Result<Selection> {
  const levels: ReadonlyArray<readonly ["flag" | "env" | "stored", string | undefined, string]> = [
    ["flag", input.flag, "--terminal"],
    ["env", input.env.MEGABRAIN_TERMINAL, "MEGABRAIN_TERMINAL"],
    ["stored", input.stored, "terminal-default"],
  ];
  for (const [source, value, origin] of levels) {
    if (value === undefined || value.trim() === "") continue;
    const parsed = choice(value, origin);
    if (parsed.kind !== "ok") return parsed;
    if (parsed.value === "none") return ok({ kind: "none", source });
    if (parsed.value === "auto") break;
    return ok({ kind: "opener", name: parsed.value, source });
  }
  const detected = detectTerminal(input.env);
  return ok(detected === undefined ? { kind: "none", source: "undetected" } : { kind: "opener", name: detected, source: "detected" });
}

export function shellWords(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

export function appleScriptString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function attachArgv(session: string, server?: string): readonly string[] {
  return server === undefined ? ["tmux", "attach", "-t", session] : ["tmux", "-L", server, "attach", "-t", session];
}

export type OpenerContext = Readonly<{ env: Environment; platform: Platform }>;
// detached: the opener process lives as long as the window, so it must not be awaited.
export type OpenerInvocation = Readonly<{ command: string; args: readonly string[]; detached: boolean }>;

function appleScript(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => ["-e", line]);
}

// Arguments are always argv arrays. Only the two AppleScript openers need a shell string, because
// "do script" and "create window ... command" hand their text to a shell: every word is
// single-quoted for the shell first, then the whole string is escaped for AppleScript.
export function openerInvocation(name: OpenerName, argv: readonly string[], context: OpenerContext): OpenerInvocation {
  const { env, platform } = context;
  switch (name) {
    case "terminal-app":
      return { command: "osascript", detached: false, args: appleScript([
        'tell application "Terminal"',
        "activate",
        `do script ${appleScriptString(shellWords(argv))}`,
        "return id of front window",
        "end tell",
      ]) };
    case "iterm2":
      return { command: "osascript", detached: false, args: appleScript([
        'tell application "iTerm"',
        "activate",
        `create window with default profile command ${appleScriptString(shellWords(argv))}`,
        "end tell",
      ]) };
    case "ghostty":
      return platform === "darwin"
        ? { command: "open", args: ["-na", "Ghostty", "--args", "-e", ...argv], detached: false }
        : { command: "ghostty", args: ["-e", ...argv], detached: true };
    case "wezterm":
      return nonEmpty(env.WEZTERM_PANE)
        ? { command: "wezterm", args: ["cli", "spawn", "--new-window", "--", ...argv], detached: false }
        : { command: "wezterm", args: ["start", "--", ...argv], detached: true };
    case "kitty":
      return nonEmpty(env.KITTY_LISTEN_ON)
        ? { command: "kitten", args: ["@", "launch", "--type=os-window", ...argv], detached: false }
        : { command: "kitty", args: [...argv], detached: true };
    case "alacritty": return { command: "alacritty", args: ["-e", ...argv], detached: true };
    case "gnome-terminal": return { command: "gnome-terminal", args: ["--", ...argv], detached: true };
    case "konsole": return { command: "konsole", args: ["-e", ...argv], detached: true };
    case "xterm": return { command: "xterm", args: ["-e", ...argv], detached: true };
    case "windows-terminal": return { command: "wt.exe", args: ["-w", "new", "new-tab", ...argv], detached: true };
  }
}

export type OpenerProbe = Readonly<{ name: OpenerName; label: string; available: boolean; verified: boolean }>;

export async function probeOpeners(input: Readonly<{
  platform: Platform;
  home: string;
  which: (command: string) => Promise<boolean>;
  exists: (path: string) => boolean;
}>): Promise<readonly OpenerProbe[]> {
  const probes: OpenerProbe[] = [];
  for (const opener of OPENERS) {
    if (!opener.platforms.includes(input.platform)) continue;
    let available = false;
    if (input.platform === "darwin") {
      const bundles = opener.bundles.flatMap((bundle) => [bundle, `${input.home}/Applications/${bundle.split("/").pop() ?? bundle}`]);
      available = bundles.some((bundle) => input.exists(bundle));
    }
    for (const binary of opener.binaries) {
      if (available) break;
      available = await input.which(binary);
    }
    probes.push({ name: opener.name, label: opener.label, available, verified: opener.verified });
  }
  return probes;
}

export function probeSummary(probes: readonly OpenerProbe[]): string {
  return probes.map((probe) => {
    if (!probe.available) return `${probe.name}: missing`;
    return `${probe.name}: available${probe.verified ? "" : " (unverified)"}`;
  }).join("; ");
}
