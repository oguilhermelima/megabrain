import { realpath } from "node:fs/promises";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { readArchivedWorktrees, writeArchivedWorktrees, type ArchivedWorktree } from "../../core/archived-worktrees.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";
import { repoFromOrca } from "./repository-selector.js";
import { defaultBase, localBranchExists, parentBranch, pathFor, removalReason, removeFinishWorktree, repositoryRoot, root, run, workspaceForTarget } from "./worktree-write.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Options = { target?: string; repo?: string; force: boolean; json: boolean };

function parse(args: readonly string[], allowForce: boolean): Result<Options> {
  const options: Options = { force: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--json") options.json = true;
    else if (arg === "--force" && allowForce) options.force = true;
    else if (arg === "--repo") {
      const value = args[index + 1];
      if (!value) return failed("--repo requires a non-empty value", 2);
      options.repo = value;
      index += 1;
    } else if (arg.startsWith("-")) return failed(`unknown option: ${arg}`, 2);
    else if (options.target === undefined) options.target = arg;
    else return failed(`unexpected argument: ${arg}`, 2);
  }
  return ok(options);
}

const render = (json: boolean, value: unknown, human: string): Result<string> => ok(json ? `${JSON.stringify(value, null, 2)}\n` : human);

async function checkoutOf(process: ProcessAdapter, repo: string, target: string): Promise<string | undefined> {
  const listed = await run(process, "git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (listed.kind !== "ok") return undefined;
  const canonical = await realpath(target).catch(() => target);
  let path = "";
  for (const line of listed.value.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (line === `branch refs/heads/${target}` || (line.startsWith("worktree ") && (path === target || path === canonical))) return path;
  }
  return undefined;
}

async function pullRequestOf(process: ProcessAdapter, repo: string, branch: string): Promise<ArchivedWorktree["pullRequest"]> {
  const listed = await process.run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,url"], { cwd: repo });
  if (listed.kind !== "ok") return null;
  try {
    const first = (JSON.parse(listed.value.stdout) as Array<{ number?: unknown; state?: unknown; url?: unknown }>)[0];
    return typeof first?.number === "number" && typeof first.state === "string" && typeof first.url === "string" ? { number: first.number, state: first.state, url: first.url } : null;
  } catch { return null; }
}

// What would be lost with the folder: uncommitted files, and commits no remote and no parent branch has.
async function unsavedWork(process: ProcessAdapter, repo: string, path: string, parent: string | undefined): Promise<string[]> {
  const problems: string[] = [];
  const status = await run(process, "git", ["-C", path, "status", "--porcelain"]);
  const files = status.kind === "ok" ? status.value.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3)) : [];
  if (files.length > 0) problems.push(`uncommitted changes (${files.join(", ")})`);
  const upstream = await run(process, "git", ["-C", path, "rev-parse", "--abbrev-ref", "@{upstream}"]);
  const base = parent ?? await defaultBase(process, repo);
  const baseExists = await localBranchExists(process, repo, base);
  const range = upstream.kind === "ok" ? ["@{upstream}..HEAD"] : ["HEAD", "--not", "--remotes", ...(baseExists.kind === "ok" && baseExists.value ? [base] : [])];
  const ahead = await run(process, "git", ["-C", path, "rev-list", "--count", ...range]);
  const count = ahead.kind === "ok" ? Number(ahead.value.stdout.trim()) : 0;
  if (count > 0) problems.push(`${count} unpushed commit${count === 1 ? "" : "s"}`);
  return problems;
}

export async function executeWorktreeArchive(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const parsed = parse(args, true);
  if (parsed.kind !== "ok") return parsed;
  const { target, repo: repoSelector, force, json } = parsed.value;
  if (target === undefined) return failed("Usage: megabrain worktree archive <branch|path> [--repo <name|path>] [--force] [--json]", 2);

  let found: string | undefined;
  if (repoSelector !== undefined) {
    const selected = await repoFromOrca(process, repoSelector, environment);
    if (selected.kind !== "ok") return selected;
    found = await checkoutOf(process, selected.value, target);
    if (found === undefined) return failed(`worktree not found: ${target}`);
  } else {
    const shared = await root(environment, true);
    if (shared.kind !== "ok") return shared;
    const located = await pathFor(process, target, shared.value, environment);
    if (located.kind !== "ok") return located;
    found = located.value;
  }
  const path = await realpath(found).catch(() => found);
  const repo = await repositoryRoot(process, path);
  if (repo.kind !== "ok") return repo;
  const repoPath = await realpath(repo.value).catch(() => repo.value);
  if (path === repoPath) return failed(`refusing to archive the primary checkout: ${path}`);
  const head = await run(process, "git", ["-C", path, "rev-parse", "HEAD"]);
  const current = await run(process, "git", ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = current.kind === "ok" ? current.value.stdout.trim() : "";
  if (head.kind !== "ok" || branch === "") return failed(`cannot archive a detached worktree: ${path}`);
  const parent = await parentBranch(process, path, branch);

  if (!force) {
    const problems = await unsavedWork(process, repoPath, path, parent);
    if (problems.length > 0) return failed([`refusing to archive ${branch} (use --force to override):`, ...problems.map((problem) => `- ${problem}`)].join("\n"));
  }
  const workspace = await workspaceForTarget(process, path);
  if (workspace.kind !== "ok") return workspace;
  const removed = await removeFinishWorktree(process, repoPath, path, force, workspace.value);
  if (removed.kind !== "ok") return failed(`could not remove worktree ${path}: ${removalReason(removed.error)}`, removed.exitCode);

  const record: ArchivedWorktree = { repo: repoPath, branch, head: head.value.stdout.trim(), archivedAt: new Date().toISOString(), parent: parent ?? null, pullRequest: await pullRequestOf(process, repoPath, branch), path };
  try {
    const rest = (await readArchivedWorktrees(environment)).filter((item) => !(item.repo === repoPath && item.branch === branch));
    await writeArchivedWorktrees(environment, [...rest, record]);
  } catch (error) { return failed(`worktree ${path} was removed and branch ${branch} kept at ${record.head}, but the archive record could not be saved: ${String(error)}`); }
  try { await callStateOwner(resolveStateDirectory(environment), { operation: "worktree-write", action: "finish", path, finishedAt: record.archivedAt }); }
  catch (cause: unknown) { return failed(`worktree ${path} was removed and branch ${branch} kept, but registry update failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  return render(json, record, `archived: ${branch} (${path} removed, branch kept)\n`);
}

export async function executeWorktreeArchived(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const parsed = parse(args, false);
  if (parsed.kind !== "ok") return parsed;
  if (parsed.value.target !== undefined) return failed("Usage: megabrain worktree archived [--repo <name|path>] [--json]", 2);
  let items = await readArchivedWorktrees(environment);
  if (parsed.value.repo !== undefined) {
    const selected = await repoFromOrca(process, parsed.value.repo, environment);
    if (selected.kind !== "ok") return selected;
    const repo = await realpath(selected.value).catch(() => selected.value);
    items = items.filter((item) => item.repo === repo);
  }
  return render(parsed.value.json, { archived: items }, items.map((item) => `${item.branch}  ${item.repo}  ${item.archivedAt}\n`).join(""));
}

export async function executeWorktreeUnarchive(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const parsed = parse(args, false);
  if (parsed.kind !== "ok") return parsed;
  const { target: branch, repo: repoSelector, json } = parsed.value;
  if (branch === undefined) return failed("Usage: megabrain worktree unarchive <branch> [--repo <name|path>] [--json]", 2);
  const items = await readArchivedWorktrees(environment);
  let wanted = items.filter((item) => item.branch === branch);
  if (repoSelector !== undefined) {
    const selected = await repoFromOrca(process, repoSelector, environment);
    if (selected.kind !== "ok") return selected;
    const repo = await realpath(selected.value).catch(() => selected.value);
    wanted = wanted.filter((item) => item.repo === repo);
  }
  if (wanted.length === 0) return failed(`no archived worktree for branch ${branch}`);
  const record = wanted[0] as ArchivedWorktree;
  if (wanted.length > 1) return failed(`branch ${branch} is archived in ${wanted.length} repositories; pass --repo`);
  const exists = await localBranchExists(process, record.repo, branch);
  if (exists.kind !== "ok" || !exists.value) return failed(`branch ${branch} no longer exists in ${record.repo}`);
  const occupied = await run(process, "sh", ["-c", 'test -e "$1"', "sh", record.path]);
  if (occupied.kind === "ok") return failed(`cannot restore ${branch}: ${record.path} already exists`);
  const added = await run(process, "git", ["-C", record.repo, "worktree", "add", record.path, branch]);
  if (added.kind !== "ok") return failed(`could not restore ${branch}: ${removalReason(added.error)}`);
  if (record.parent !== null) await run(process, "git", ["-C", record.repo, "config", `branch.${branch}.megabrain-parent`, record.parent]);
  await writeArchivedWorktrees(environment, items.filter((item) => item !== record));
  try { await callStateOwner(resolveStateDirectory(environment), { operation: "worktree-write", action: "reopen", path: record.path }); }
  catch (cause: unknown) { return failed(`worktree ${branch} was restored, but registry update failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  return render(json, { repo: record.repo, branch, path: record.path, parent: record.parent }, `restored: ${branch} at ${record.path}\n`);
}
