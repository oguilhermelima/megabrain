import { realpath, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { formatAdopt, parseAdoptOptions, type AdoptResult } from "../../core/worktree-adopt.js";
import { resolveStateDirectory } from "../../core/state.js";
import { usageText } from "../../core/usage.js";

export type AdoptEnvironment = Readonly<Record<string, string | undefined>>;

async function run(process: ProcessAdapter, command: string, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run(command, args);
  return result.kind === "ok" ? ok(result.value.stdout) : failed(result.error, result.exitCode);
}

async function canonical(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

async function sharedRoot(environment: AdoptEnvironment): Promise<Result<string>> {
  const state = resolveStateDirectory(environment);
  let raw: string;
  try { raw = (await readFile(join(state, "worktree-root"), "utf8")).trim(); } catch {
    return failed(`shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`);
  }
  if (raw.length === 0) return failed(`shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`);
  const expanded = raw.startsWith("~") ? join(environment.HOME ?? process.cwd(), raw.slice(1)) : raw;
  return ok((await canonical(resolve(expanded))) ?? resolve(expanded));
}

async function selectorPath(process: ProcessAdapter, target: string, root: string): Promise<Result<string>> {
  const direct = await canonical(target);
  if (direct !== undefined) {
    const gitRoot = await run(process, "git", ["-C", target, "rev-parse", "--show-toplevel"]);
    if (gitRoot.kind !== "ok") return failed(`worktree path is not a Git directory: ${target}`);
    const canonicalGitRoot = await canonical(gitRoot.value.trim());
    if (canonicalGitRoot !== direct) return failed(`worktree selector points to subdirectory: ${direct}; pass the worktree root ${canonicalGitRoot ?? gitRoot.value.trim()} and put cd ${direct} in the command`);
    return ok(direct);
  }
  const listed = await run(process, "git", ["worktree", "list", "--porcelain"]);
  if (listed.kind !== "ok") return failed(`physical worktree not found: ${target}`);
  let path = "";
  for (const line of listed.value.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${target}`) break;
    if (line.startsWith("branch ") && path.endsWith(`/${target}`)) break;
  }
  const resolved = await canonical(path);
  return resolved === undefined ? failed(`physical worktree not found: ${target}`) : ok(resolved);
}

export async function executeWorktreeAdopt(args: readonly string[], environment: AdoptEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  const options = parseAdoptOptions(args);
  if (options.kind !== "ok") return options;
  if (options.value.target.length === 0) return ok(usageText("worktree-adopt"));
  const root = await sharedRoot(environment);
  if (root.kind !== "ok") return root;
  const path = await selectorPath(process, options.value.target, root.value);
  if (path.kind !== "ok") return path;
  if (!path.value.startsWith(`${root.value}/`)) return failed(`worktree is outside Superset's shared root: ${path.value}`);
  const repo = await run(process, "git", ["-C", path.value, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await run(process, "git", ["-C", path.value, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (repo.kind !== "ok") return repo;
  if (branch.kind !== "ok" || branch.value.trim().length === 0) return failed(`cannot adopt detached worktree: ${path.value}`);
  const repoPath = repo.value.trim().replace(/\/\.git\s*$/, "");
  const workspaces = await run(process, "superset", ["workspaces", "list", "--local", "--json"]);
  if (workspaces.kind !== "ok") return workspaces;
  try {
    const value: unknown = JSON.parse(workspaces.value);
    const workspaceRecords = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { result?: { workspaces?: unknown[] } }).result?.workspaces) ? (value as { result: { workspaces: unknown[] } }).result.workspaces : [];
    if (workspaceRecords.some((item) => typeof item === "object" && item !== null && ((item as { branch?: unknown }).branch === branch.value.trim() || (item as { worktreePath?: unknown }).worktreePath === path.value))) {
      return failed(`worktree is already registered in Superset: ${path.value}`);
    }
  } catch { /* shell treats malformed discovery as absent */ }
  const projects = await run(process, "superset", ["projects", "list", "--json"]);
  if (projects.kind !== "ok") return projects;
  let projectId = "";
  try {
    const value: unknown = JSON.parse(projects.value);
    const records = Array.isArray(value) ? value : typeof value === "object" && value !== null && Array.isArray((value as { result?: { projects?: unknown[] } }).result?.projects) ? (value as { result: { projects: unknown[] } }).result.projects : [];
    for (const item of records) if (typeof item === "object" && item !== null && ((item as { path?: unknown }).path === repoPath || (item as { localPath?: unknown }).localPath === repoPath || (item as { repoPath?: unknown }).repoPath === repoPath)) projectId = String((item as { id?: unknown }).id ?? "");
  } catch { /* shell treats malformed discovery as absent */ }
  if (projectId.length === 0) {
    const created = await run(process, "superset", ["projects", "create", "--local", "--import", repoPath, "--name", basename(repoPath), "--json"]);
    if (created.kind !== "ok") return created;
    try { projectId = String((JSON.parse(created.value) as { result?: { project?: { id?: string }; id?: string }; id?: string }).result?.project?.id ?? (JSON.parse(created.value) as { result?: { id?: string }; id?: string }).result?.id ?? JSON.parse(created.value).id ?? ""); } catch { projectId = ""; }
  }
  if (projectId.length === 0) return failed(`could not register Superset project for ${repoPath}`);
  const workspace = await run(process, "superset", ["workspaces", "create", "--local", "--project", projectId, "--branch", branch.value.trim(), "--name", basename(path.value), "--json"]);
  if (workspace.kind !== "ok") return workspace;
  let workspaceId = "";
  try { workspaceId = String((JSON.parse(workspace.value) as { result?: { workspace?: { id?: string }; id?: string }; id?: string }).result?.workspace?.id ?? (JSON.parse(workspace.value) as { result?: { id?: string }; id?: string }).result?.id ?? JSON.parse(workspace.value).id ?? ""); } catch { workspaceId = ""; }
  if (workspaceId.length === 0) return failed(`could not create or find Superset workspace for ${branch.value.trim()}`);
  const result: AdoptResult = { worktree: path.value, branch: branch.value.trim(), workspace: workspaceId };
  return ok(formatAdopt(result, options.value.json));
}
