import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";

type Entry = Readonly<{ name: string; description: string | null; source: "builtin" | "user" | "project" | "skill" | "plugin"; argumentHint?: string | null }>;
type Frontmatter = Readonly<{ name?: string; description?: string; argumentHint?: string }>;

// Claude Code 2.1.300 built-in command set. The installed executable does not expose a
// machine-readable command listing, so keep this list versioned with the verified source.
const CLAUDE_BUILTINS = ["clear", "compact", "config", "context", "cost", "doctor", "exit", "export", "help", "hooks", "ide", "init", "install-github-app", "login", "logout", "memory", "mcp", "model", "permissions", "plugin", "pr", "release-notes", "review", "status", "terminal-setup", "vim"];
const CODEX_BUILTINS = ["model", "approvals", "skills", "review", "compact", "clear", "logout", "quit", "exit", "new", "resume", "fork", "init", "diff", "mention", "status", "mcp", "ps", "experimental"];
// Codex CLI 0.162.1 built-in slash actions; its --help lists CLI subcommands, not a slash-command API.

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }));
  }
  await visit(root);
  return files.sort();
}

function frontmatter(contents: string): Frontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(contents);
  if (match?.[1] === undefined) return {};
  const values: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) values[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
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
    entries.push(...await filesAsEntries((await markdownFiles(join(home, ".claude", "skills"))).filter((path) => basename(path) === "SKILL.md"), join(home, ".claude", "skills"), "skill", false));
    entries.push(...await filesAsEntries((await markdownFiles(join(project, ".claude", "skills"))).filter((path) => basename(path) === "SKILL.md"), join(project, ".claude", "skills"), "skill", false));
    let plugins: unknown;
    try { plugins = JSON.parse(await readFile(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")) as unknown; } catch { plugins = undefined; }
    if (typeof plugins === "object" && plugins !== null && "plugins" in plugins) {
      const installed = plugins.plugins;
      const records = Array.isArray(installed) ? installed : typeof installed === "object" && installed !== null ? Object.values(installed).flatMap((value) => Array.isArray(value) ? value : [value]) : [];
      for (const item of records) if (typeof item === "object" && item !== null && "installPath" in item && typeof item.installPath === "string") {
        const root = item.installPath;
        const commandRoot = join(root, "commands");
        entries.push(...await filesAsEntries(await markdownFiles(commandRoot), commandRoot, "plugin", true));
      }
    }
  } else if (agent === "codex") {
    entries = CODEX_BUILTINS.map((name) => ({ name, description: null, source: "builtin" }));
    const prompts = join(home, ".codex", "prompts");
    entries.push(...await filesAsEntries(await markdownFiles(prompts), prompts, "user", false));
  }
  const unique = [...new Map(entries.map((entry) => [`${entry.source}:${entry.name}`, entry])).values()];
  return ok(json ? `${JSON.stringify(unique, null, 2)}\n` : unique.map((entry) => `${entry.name}\t${entry.source}\n`).join(""));
}
