import { realpath, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { formatWorktreeList, parseGitWorktrees, parseParentConfig, parsePullRequests, parseWorkspacePaths, type GitWorktree, type ParentConfig, type WorktreeListEntry } from "../../core/worktree-list.js";
import { repoFromOrca } from "./repository-selector.js";

export type WorktreeListEnvironment = Readonly<Record<string, string | undefined>>;

type Repository = { readonly common: string; readonly path: string };

function jsonValue(output: string): unknown {
  try { return JSON.parse(output) as unknown; } catch { return undefined; }
}

async function canonical(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

async function sharedRoot(environment: WorktreeListEnvironment): Promise<Result<string>> {
  const state = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain");
  let raw: string;
  try { raw = (await readFile(join(state, "worktree-root"), "utf8")).trim(); } catch {
    return failed(`shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`);
  }
  if (raw.length === 0) return failed(`shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`);
  const expanded = raw.startsWith("~") ? join(environment.HOME ?? process.cwd(), raw.slice(1)) : raw;
  return ok((await canonical(resolve(expanded))) ?? resolve(expanded));
}

async function repositoryForDirectory(process: ProcessAdapter, path: string): Promise<Repository | undefined> {
  const top = await runGit(process, path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (top === undefined) return undefined;
  const initialTop = await canonical(top.trim());
  if (initialTop === undefined) return undefined;
  const common = await runGit(process, initialTop, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common === undefined) return undefined;
  const commonPath = await canonical(common.trim());
  if (commonPath === undefined) return undefined;
  const topPath = commonPath.endsWith("/.git")
    ? await canonical(commonPath.slice(0, -"/.git".length))
    : initialTop;
  if (topPath === undefined) return undefined;
  return { common: commonPath, path: topPath };
}

async function runGit(process: ProcessAdapter, path: string, args: readonly string[]): Promise<string | undefined> {
  const result = await process.run("git", ["-C", path, ...args]);
  return result.kind === "ok" ? result.value.stdout : undefined;
}

async function repositories(root: string, process: ProcessAdapter): Promise<Repository[]> {
  const result: Repository[] = [];
  const children = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const path = join(root, child.name);
    const marker = join(path, ".git");
    let common: string | undefined;
    try {
      if ((await (await import("node:fs/promises")).stat(marker)).isDirectory()) common = await canonical(marker);
      else {
        const contents = await readFile(marker, "utf8");
        if (contents.startsWith("gitdir: ")) {
          const gitdir = await canonical(resolve(path, contents.slice("gitdir: ".length).trim()));
          common = gitdir === undefined ? undefined : dirname(dirname(gitdir));
        }
      }
    } catch { common = undefined; }
    if (common !== undefined && !result.some((item) => item.common === common)) result.push({ common, path });
  }
  return result;
}

function optionResult(args: readonly string[]): Result<{ readonly repo?: string; readonly json: boolean; readonly flat: boolean }> {
  let repo: string | undefined;
  let json = false;
  let flat = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") { repo = args[index + 1]; index += 1; }
    else if (arg === "--json") json = true;
    else if (arg === "--flat") flat = true;
    else if (arg === "--tree") flat = false;
    else if (arg === "-h" || arg === "--help") return ok({ repo, json, flat });
    else return failed(`unknown worktree list option: ${arg}`, 2);
  }
  return ok({ repo, json, flat });
}

async function batchJson(process: ProcessAdapter, command: string, args: readonly string[]): Promise<unknown> {
  const result = await process.run(command, args);
  return result.kind === "ok" ? jsonValue(result.value.stdout) : undefined;
}

function parentFromOrca(value: unknown): Map<string, string> {
  const parents = new Map<string, string>();
  const records = Array.isArray(value) ? value : typeof value === "object" && value !== null ? ((value as Record<string, unknown>).result ?? value) : [];
  if (!Array.isArray(records)) return parents;
  for (const item of records) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : undefined;
    const parent = typeof record.parentBranch === "string" ? record.parentBranch : undefined;
    if (path !== undefined && parent !== undefined) parents.set(path, parent);
  }
  return parents;
}

export async function executeWorktreeList(args: readonly string[], environment: WorktreeListEnvironment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const options = optionResult(args);
  if (options.kind !== "ok") return options;
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain worktree list [--repo <name|path>] [--tree|--flat] [--json]\n");
  const root = await sharedRoot(environment);
  if (root.kind !== "ok") return root;
  let filter: string | undefined;
  let selectedRepository: Repository | undefined;
  if (options.value.repo !== undefined) {
    const selector = await repoFromOrca(process, options.value.repo);
    if (selector.kind !== "ok") return failed(`repo not found: ${options.value.repo}`);
    selectedRepository = await repositoryForDirectory(process, selector.value);
    if (selectedRepository === undefined) return failed(`repo not found: ${options.value.repo}`);
    filter = selectedRepository.common;
  }
  const repos = selectedRepository === undefined ? await repositories(root.value, process) : [selectedRepository];
  const gitRecords: GitWorktree[] = [];
  const parents: ParentConfig[] = [];
  for (const repository of repos) {
    if (filter !== undefined && repository.common !== filter) continue;
    const output = await runGit(process, repository.path, ["worktree", "list", "--porcelain"]);
    if (output !== undefined) gitRecords.push(...parseGitWorktrees(output, repository.common));
    const config = await runGit(process, repository.path, ["config", "--get-regexp", "^branch\\..*\\.megabrain-parent$"]);
    if (config !== undefined) parents.push(...parseParentConfig(config, repository.common));
  }
  const workspaces = parseWorkspacePaths(await batchJson(process, "superset", ["workspaces", "list", "--json"]));
  const orcaParents = parentFromOrca(await batchJson(process, "orca", ["worktree", "list", "--json"]));
  const pullRequests = parsePullRequests(await batchJson(process, "gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url"]));
  const entries: WorktreeListEntry[] = [];
  for (const record of gitRecords) {
    const path = await canonical(record.path);
    if (path === undefined) continue;
    const inSharedRoot = path === root.value || path.startsWith(`${root.value}/`);
    if (options.value.repo === undefined && !inSharedRoot) continue;
    if (filter !== undefined && record.repository !== filter) continue;
    const config = parents.find((item) => item.repository === record.repository && item.branch === record.branch);
    const parent = config?.parent ?? orcaParents.get(path) ?? null;
    entries.push({ path, branch: record.branch, parent, inSuperset: workspaces.has(path), inSharedRoot, pullRequest: pullRequests.get(record.branch) ?? null });
  }
  const formatted = formatWorktreeList(entries, options.value);
  if (options.value.json) return ok(formatted);
  const lines = formatted.split("\n");
  if (options.value.flat) {
    for (let index = 1; index < lines.length - 1; index += 1) {
      const entry = entries[index - 1];
      if (entry !== undefined && entry.path.length < 52) lines[index] = `${lines[index].slice(0, 52)}${lines[index].slice(53)}`;
    }
  } else {
    lines[0] = `${lines[0]}${" ".repeat(28)}`;
  }
  return ok(lines.join("\n"));
}
