import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";

type Entry = Readonly<{ name: string; description: string | null; source: "builtin" | "user" | "project" | "skill" | "plugin"; argumentHint?: string | null }>;
type Frontmatter = Readonly<{ name?: string; description?: string; argumentHint?: string }>;

// Claude Code 2.1.300 built-in command set. The installed executable does not expose a
// machine-readable command listing, so keep this list versioned with the verified source.
const CLAUDE_BUILTINS = ["clear", "compact", "config", "context", "cost", "doctor", "exit", "export", "help", "hooks", "ide", "init", "install-github-app", "login", "logout", "memory", "mcp", "model", "permissions", "plugin", "pr", "release-notes", "review", "status", "terminal-setup", "vim"];
const CODEX_BUILTINS = ["model", "approvals", "skills", "review", "compact", "clear", "logout", "quit", "exit", "new", "resume", "fork", "init", "diff", "mention", "status", "mcp", "ps", "experimental"];
// Codex CLI 0.162.1 built-in slash actions; its --help lists CLI subcommands, not a slash-command API.
// Grok 1.0.52 built-in slash commands, from the Slash Commands table of its own ~/.grok/README.md
// (aliases left out).
const GROK_BUILTINS: ReadonlyArray<readonly [string, string]> = [
  ["model", "Switch to a different model"], ["new", "Start a new session (clears context)"], ["load", "Load a previous session"],
  ["rewind", "Rewind to a previous prompt (restores files)"], ["compact", "Compact conversation history"], ["always-approve", "Toggle auto-approve mode"],
  ["multiline", "Toggle multiline input mode"], ["memory", "Browse, delete, and toggle memory"], ["remember", "Save a note to global memory"],
  ["flush", "Wait for memory capture of finished turns"], ["dream", "Fold memory observations into topics now"], ["skills", "List skills or inject a skill into context"],
  ["plugins", "Manage plugins (list, reload, trust)"], ["hooks-list", "Show hooks loaded in this session"], ["hooks-trust", "Trust this folder for hooks (writes folder trust)"],
  ["hooks-add", "Add a custom hook file or directory"], ["feedback", "Report an issue or send feedback"], ["exit", "Exit the TUI"],
];
// agy 1.4.0 built-in slash commands. It lists them only inside its TUI (/help); these are the names
// its binary's own changelog and usage strings refer to, so keep the list versioned with it.
const AGY_BUILTINS = ["help", "clear", "compact", "model", "effort", "resume", "rewind", "fork", "diff", "config", "settings", "permissions", "hooks", "mcp", "plugin", "skills", "agents", "tasks", "usage", "quota", "keybindings", "copy", "btw", "goal", "plan", "add-dir", "title", "changelog", "login", "logout", "exit"];

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  // Skill folders are often symlinks into a shared tree; each real folder is read once, so a link loop ends.
  const seen = new Set<string>();
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      const real = await realpath(directory);
      if (seen.has(real)) return;
      seen.add(real);
      entries = await readdir(directory, { withFileTypes: true });
    } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      let directoryEntry = entry.isDirectory();
      let fileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { const target = await stat(path); directoryEntry = target.isDirectory(); fileEntry = target.isFile(); } catch { return; }
      }
      if (directoryEntry) await visit(path);
      else if (fileEntry && entry.name.endsWith(".md")) files.push(path);
    }));
  }
  await visit(root);
  return files.sort();
}

function frontmatter(contents: string): Frontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(contents);
  if (match?.[1] === undefined) return {};
  const values: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([\w-]+):\s*(.*?)\s*$/.exec(lines[index] ?? "");
    if (field?.[1] === undefined || field[2] === undefined) continue;
    // A value may go on over the indented lines below it: a folded (>) or literal (|) block, or a plain one wrapped.
    const more: string[] = [];
    while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1] ?? "")) more.push((lines[++index] ?? "").trim());
    const block = /^([>|])[-+]?$/.exec(field[2]);
    const value = block !== null ? more.join(block[1] === "|" ? "\n" : " ") : [field[2], ...more].filter((line) => line !== "").join(" ");
    values[field[1]] = value.trim().replace(/^['"]|['"]$/g, "");
  }
  return { name: values.name, description: values.description, argumentHint: values["argument-hint"] };
}

async function filesAsEntries(paths: readonly string[], root: string, source: Entry["source"], commands: boolean): Promise<Entry[]> {
  return Promise.all(paths.map(async (path) => {
    let contents = "";
    try { contents = await readFile(path, "utf8"); } catch { /* A command may disappear during enumeration. */ }
    const meta = frontmatter(contents);
    const rel = relative(root, path).replace(/\.md$/, "").split(/[\\/]/).join(":");
    const name = commands ? rel : source === "skill" ? meta.name ?? basename(dirname(path)) : basename(path, ".md");
    return { name, description: meta.description ?? null, source, ...(commands ? { argumentHint: meta.argumentHint ?? null } : {}) };
  }));
}

/** Every SKILL.md under a skills folder, named by its frontmatter or its folder. */
async function skills(root: string): Promise<Entry[]> {
  return filesAsEntries((await markdownFiles(root)).filter((path) => basename(path) === "SKILL.md"), root, "skill", false);
}

/** The commands of Claude's installed plugins, which Grok reads too. */
async function claudePluginCommands(home: string): Promise<Entry[]> {
  let plugins: unknown;
  try { plugins = JSON.parse(await readFile(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as unknown; } catch { plugins = undefined; }
  if (typeof plugins !== "object" || plugins === null || !("plugins" in plugins)) return [];
  const installed = plugins.plugins;
  const records = Array.isArray(installed) ? installed : typeof installed === "object" && installed !== null ? Object.values(installed).flatMap((value) => Array.isArray(value) ? value : [value]) : [];
  const entries: Entry[] = [];
  for (const item of records) if (typeof item === "object" && item !== null && "installPath" in item && typeof item.installPath === "string") {
    const commandRoot = join(item.installPath, "commands");
    entries.push(...await filesAsEntries(await markdownFiles(commandRoot), commandRoot, "plugin", true));
  }
  return entries;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** The nearest folder at or above `folder` holding .git, or `folder` itself outside a repository. */
async function repositoryRoot(folder: string): Promise<string> {
  for (let current = folder; ; current = dirname(current)) {
    if (await exists(join(current, ".git"))) return current;
    if (dirname(current) === current) return folder;
  }
}

/** The folders from `root` down to `folder`, outermost first. */
function foldersUpTo(folder: string, root: string): string[] {
  const folders: string[] = [];
  for (let current = folder; ; current = dirname(current)) {
    folders.unshift(current);
    if (current === root || dirname(current) === current) return folders;
  }
}

export async function executeCommands(args: readonly string[], environment: Readonly<Record<string, string | undefined>>): Promise<Result<string>> {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: megabrain commands --agent <claude|codex|grok|agy> --cwd <path> [--json]\n");
  let agent = "";
  let cwd = "";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--agent") agent = args[++index] ?? "";
    else if (args[index] === "--cwd") cwd = args[++index] ?? "";
    else if (args[index] === "--json") json = true;
    else return failed("Usage: megabrain commands --agent <claude|codex|grok|agy> --cwd <path> [--json]", 2);
  }
  if (!(["claude", "codex", "grok", "agy"] as const).includes(agent as "claude" | "codex" | "grok" | "agy") || cwd === "") return failed("Usage: megabrain commands --agent <claude|codex|grok|agy> --cwd <path> [--json]", 2);
  const home = environment.HOME ?? process.env.HOME ?? "";
  const project = resolve(cwd);
  let entries: Entry[] = [];
  if (agent === "claude") {
    entries = CLAUDE_BUILTINS.map((name) => ({ name, description: null, source: "builtin" }));
    entries.push(...await filesAsEntries(await markdownFiles(join(home, ".claude", "commands")), join(home, ".claude", "commands"), "user", true));
    entries.push(...await filesAsEntries(await markdownFiles(join(project, ".claude", "commands")), join(project, ".claude", "commands"), "project", true));
    entries.push(...await skills(join(home, ".claude", "skills")));
    entries.push(...await skills(join(project, ".claude", "skills")));
    entries.push(...await claudePluginCommands(home));
  } else if (agent === "codex") {
    entries = CODEX_BUILTINS.map((name) => ({ name, description: null, source: "builtin" }));
    const prompts = join(home, ".codex", "prompts");
    entries.push(...await filesAsEntries(await markdownFiles(prompts), prompts, "user", false));
  } else if (agent === "grok") {
    // Lowest priority first, so a skill of the same name from a nearer folder replaces it.
    entries = GROK_BUILTINS.map(([name, description]) => ({ name, description, source: "builtin" }));
    const repo = await repositoryRoot(project);
    for (const root of [join(home, ".claude", "skills"), join(home, ".grok", "bundled", "skills"), join(home, ".grok", "skills"), join(project, ".claude", "skills"), join(repo, ".grok", "skills"), join(project, ".grok", "skills")]) entries.push(...await skills(root));
    entries.push(...await claudePluginCommands(home));
  } else {
    entries = AGY_BUILTINS.map((name) => ({ name, description: null, source: "builtin" }));
    entries.push(...await skills(join(home, ".gemini", "antigravity-cli", "builtin", "skills")));
    entries.push(...await skills(join(home, ".gemini", "config", "skills")));
    for (const folder of foldersUpTo(project, await repositoryRoot(project))) {
      for (const name of [".agents", ".agent", "_agents", "_agent"]) entries.push(...await skills(join(folder, name, "skills")));
    }
  }
  const unique = [...new Map(entries.map((entry) => [`${entry.source}:${entry.name}`, entry])).values()];
  return ok(json ? `${JSON.stringify(unique, null, 2)}\n` : unique.map((entry) => `${entry.name}\t${entry.source}\n`).join(""));
}
