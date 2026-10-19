import { access, chmod, mkdir, realpath, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabaseReadOnly } from "../../db/db.js";
import { listWorktrees as listRegisteredWorktrees } from "../../db/queries/worktrees.js";
import { getRepositoryPullRequests, listRepositories } from "../../db/queries/repositories.js";
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";
import { formatWorktreeList, parseGitWorktrees, parseParentConfig, parsePullRequests, parseWorkspacePaths, type GitWorktree, type ParentConfig, type WorktreeListEntry } from "../../core/worktree-list.js";
import { repoFromOrca } from "./repository-selector.js";
import { usageText } from "../../core/usage.js";

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

async function repositoryForDirectory(process: ProcessAdapter, path: string): Promise<Result<Repository>> {
  const top = await runGit(process, path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (top.kind !== "ok") return failed(`could not resolve repository: ${top.error}`, top.exitCode);
  const initialTop = await canonical(top.value.trim());
  if (initialTop === undefined) return failed(`could not resolve repository path: ${path}`);
  const common = await runGit(process, initialTop, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.kind !== "ok") return failed(`could not resolve repository Git directory: ${common.error}`, common.exitCode);
  const commonPath = await canonical(common.value.trim());
  if (commonPath === undefined) return failed(`could not resolve repository Git directory: ${common.value.trim()}`);
  const topPath = commonPath.endsWith("/.git")
    ? await canonical(commonPath.slice(0, -"/.git".length))
    : initialTop;
  if (topPath === undefined) return failed(`could not resolve repository path: ${commonPath}`);
  return ok({ common: commonPath, path: topPath });
}

// A non-bare repository's common dir is <checkout>/.git; a bare one has no checkout, so the
// directory the scan found it through stands in.
function repositoryOf(common: string, repos: readonly Repository[]): { name: string; path: string } {
  const path = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : repos.find((repository) => repository.common === common)?.path ?? common;
  return { name: basename(path), path };
}

async function runGit(process: ProcessAdapter, path: string, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run("git", ["-C", path, ...args], { timeoutMs: 2_000 });
  return result.kind === "ok" ? ok(result.value.stdout) : failed(result.error, result.exitCode);
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
  const result = await process.run(command, args, { timeoutMs: 2_000 });
  return result.kind === "ok" ? jsonValue(result.value.stdout) : undefined;
}

async function available(command: string, environment: WorktreeListEnvironment): Promise<boolean> {
  const paths = (environment.PATH ?? process.env.PATH ?? "").split(":");
  for (const directory of paths) {
    if (directory === "") continue;
    try { await access(join(directory, command), constants.X_OK); return true; } catch { /* Try the next PATH entry. */ }
  }
  return false;
}

function pullRequestValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

type PullRequestCache = { version: 1; repositories: Record<string, { fetchedAt: number; value: unknown }> };

async function readPullRequestCache(stateDirectory: string): Promise<PullRequestCache> {
  try {
    const value: unknown = JSON.parse(await readFile(join(stateDirectory, "worktree-pull-requests.json"), "utf8"));
    if (typeof value !== "object" || value === null || (value as Record<string, unknown>).version !== 1 || typeof (value as Record<string, unknown>).repositories !== "object") {
      return { version: 1, repositories: {} };
    }
    return value as PullRequestCache;
  } catch { return { version: 1, repositories: {} }; }
}

async function writePullRequestCache(stateDirectory: string, cache: PullRequestCache): Promise<void> {
  const path = join(stateDirectory, "worktree-pull-requests.json");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch { /* The read remains useful when the state directory is read-only. */ }
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
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("worktree-list"));
  const root = await sharedRoot(environment);
  if (root.kind !== "ok") return root;
  let filter: string | undefined;
  let selectedRepository: Repository | undefined;
  if (options.value.repo !== undefined) {
    const selector = await repoFromOrca(process, options.value.repo, environment);
    if (selector.kind !== "ok") return failed(`repo not found: ${options.value.repo}`);
    const resolved = await repositoryForDirectory(process, selector.value);
    if (resolved.kind !== "ok") return failed(`repo not found: ${options.value.repo} (${resolved.error})`, resolved.exitCode);
    selectedRepository = resolved.value;
    filter = selectedRepository.common;
  }
  const repos = selectedRepository === undefined ? await repositories(root.value, process) : [selectedRepository];
  const gitResults = await Promise.all(repos.filter((repository) => filter === undefined || repository.common === filter).map(async (repository) => {
    const [output, config] = await Promise.all([
      runGit(process, repository.path, ["worktree", "list", "--porcelain"]),
      runGit(process, repository.path, ["config", "--get-regexp", "^branch\\..*\\.megabrain-parent$"]),
    ]);
    return { repository, output, config };
  }));
  const failedWorktreeList = gitResults.find((result) => result.output.kind !== "ok");
  if (failedWorktreeList !== undefined) {
    const error = failedWorktreeList.output.kind === "failed" ? failedWorktreeList.output : undefined;
    return failed(`could not list worktrees for ${failedWorktreeList.repository.path}: ${error?.error ?? "git returned no result"}`, error?.exitCode);
  }
  const gitRecords = gitResults.flatMap((result) => result.output.kind === "ok" ? parseGitWorktrees(result.output.value, result.repository.common) : []);
  const parents = gitResults.flatMap((result) => result.config.kind === "ok" ? parseParentConfig(result.config.value, result.repository.common) : []);
  const tools = await Promise.all(["superset", "orca", "gh"].map(async (command) => [command, await available(command, environment)] as const));
  const installed = new Map(tools);
  const [workspaceData, orcaData] = await Promise.all([
    installed.get("superset") ? batchJson(process, "superset", ["workspaces", "list", "--json"]) : Promise.resolve(undefined),
    installed.get("orca") ? batchJson(process, "orca", ["worktree", "list", "--json"]) : Promise.resolve(undefined),
  ]);
  const workspaces = parseWorkspacePaths(workspaceData);
  const orcaParents = parentFromOrca(orcaData);
  const stateDirectory = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? globalThis.process.cwd(), ".megabrain");
  const prCache = await readPullRequestCache(stateDirectory);
  let prCacheChanged = false;
  const pullRequests = new Map<string, ReturnType<typeof parsePullRequests> extends Map<string, infer T> ? T : never>();
  const now = Date.now();
  const uncached: Repository[] = [];
  for (const repository of repos) {
    const cached = prCache.repositories[repository.path];
    if (cached !== undefined && cached.fetchedAt <= now && now - cached.fetchedAt < 60_000) {
      for (const [branch, pull] of parsePullRequests(cached.value)) pullRequests.set(branch, pull);
    } else uncached.push(repository);
  }
  const registry = openDatabaseReadOnly(environment);
  const registered = new Map<string, ReturnType<typeof listRegisteredWorktrees>[number]>();
  const repositoryRecords = new Map<string, ReturnType<typeof listRepositories>[number]>();
  let refresh = uncached;
  if (registry.kind === "ok") {
    try {
      for (const item of listRegisteredWorktrees(registry.value.db)) registered.set(item.path, item);
      for (const item of listRepositories(registry.value.db)) repositoryRecords.set(item.path, item);
      refresh = [];
      for (const repository of uncached) {
        const record = repositoryRecords.get(repository.path);
        const cached = record === undefined ? undefined : getRepositoryPullRequests(registry.value.db, record.path);
        if (cached !== undefined && cached.fetchedAt <= now && now - cached.fetchedAt < 60_000) {
          for (const [branch, pull] of parsePullRequests(pullRequestValue(cached.value))) pullRequests.set(branch, pull);
          const value = pullRequestValue(cached.value);
          if (value !== undefined) prCache.repositories[repository.path] = { fetchedAt: cached.fetchedAt, value };
        } else refresh.push(repository);
      }
      if (installed.get("gh") && refresh.length > 0) {
        const values = await Promise.all(refresh.map(async (repository) => {
          const result = await process.run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url"], { cwd: repository.path, timeoutMs: 2_000 });
          return { repository, result };
        }));
        for (const { repository, result } of values) {
          const parsed = result.kind === "ok" ? pullRequestValue(result.value.stdout) : undefined;
          const previous = prCache.repositories[repository.path]?.value;
          const usable = Array.isArray(parsed) ? parsed : previous ?? [];
          for (const [branch, pull] of parsePullRequests(usable)) pullRequests.set(branch, pull);
          prCache.repositories[repository.path] = { fetchedAt: now, value: usable };
          prCacheChanged = true;
          const record = repositoryRecords.get(repository.path);
          if (record !== undefined) await callStateOwner(resolveStateDirectory(environment), { operation: "repository-pull-request-cache-write", path: record.path, value: JSON.stringify(usable), fetchedAt: now });
        }
      }
    }
    finally { registry.value.close(); }
  } else if (installed.get("gh")) {
    const values = await Promise.all(refresh.map(async (repository) => ({ repository, value: await batchJson(process, "gh", ["-C", repository.path, "pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,number,state,url"]) })));
    for (const { repository, value } of values) {
      for (const [branch, pull] of parsePullRequests(value)) pullRequests.set(branch, pull);
      if (Array.isArray(value)) { prCache.repositories[repository.path] = { fetchedAt: now, value }; prCacheChanged = true; }
    }
  }
  if (prCacheChanged) {
    for (const [path, entry] of Object.entries(prCache.repositories)) {
      if (!Number.isFinite(entry.fetchedAt) || entry.fetchedAt > now || now - entry.fetchedAt >= 60_000) {
        delete prCache.repositories[path];
      }
    }
    await writePullRequestCache(stateDirectory, prCache);
  }
  const entries: WorktreeListEntry[] = [];
  for (const record of gitRecords) {
    const path = await canonical(record.path);
    if (path === undefined) continue;
    const inSharedRoot = path === root.value || path.startsWith(`${root.value}/`);
    if (options.value.repo === undefined && !inSharedRoot) continue;
    if (filter !== undefined && record.repository !== filter) continue;
    const config = parents.find((item) => item.repository === record.repository && item.branch === record.branch);
    const parent = config?.parent ?? orcaParents.get(path) ?? null;
    const stored = registered.get(path);
    const ageDays = stored === undefined ? null : Math.max(0, Math.floor((Date.now() - Date.parse(stored.createdAt)) / 86_400_000));
    entries.push({
      path, branch: record.branch, parent, inSuperset: workspaces.has(path), inSharedRoot,
      pullRequest: pullRequests.get(record.branch) ?? null,
      createdAt: stored?.createdAt ?? null, ageDays, purpose: stored?.purpose ?? null,
      origin: stored?.origin ?? "discovered", createdByMegabrain: stored?.origin === "created",
      repository: repositoryOf(record.repository, repos),
    });
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
