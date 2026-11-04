import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  createName,
  finishJson,
  parseCreateOptions,
  parseFinishOptions,
  parsePullRequestOptions,
  type CreateOptions,
  type FinishOptions,
  type PullRequestOptions,
} from "../../core/worktree-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { resolveCaller } from "./queue-write.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { insertWorktree, finishWorktree } from "../../db/queries/worktrees.js";
import { listRepositories } from "../../db/queries/repositories.js";
import {
  defaultWorktreeLocation,
  parseWorktreeLocation,
  placementFor,
  worktreeParent,
  type WorktreeLocation,
} from "../../core/worktree-location.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";

import { defaultBase, localBranchExists, parentBranch, run, type Environment } from "./worktree-write-base.js";
import { hasCommand, isRecord, stringField, type FinishBase, type Workspace } from "./worktree-write-workspace.js";
export function removalReason(error: string): string {
  const compact = error.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  try {
    const parsed: unknown = JSON.parse(error);
    if (isRecord(parsed)) {
      const nested = parsed.error;
      if (typeof nested === "string" && nested.length > 0) return nested;
      if (isRecord(nested)) {
        const message = stringField(nested, ["message", "code"]);
        if (message !== undefined) return message;
      }
      const message = stringField(parsed, ["message", "code"]);
      if (message !== undefined) return message;
    }
  } catch {
    // The host remover may return plain text instead of JSON.
  }
  return compact.length > 0 ? compact : "the remover gave no reason";
}

/**
 * Git ancestry alone misses rebase and squash merges. Patch equivalence covers rebases and equal
 * trees cover an exact squash result; GitHub's merged-PR record covers squash merges followed by
 * later base commits. Forge lookup is deliberately best-effort so offline Git-only finish still
 * works.
 */
export async function changesAlreadyMerged(
  process: ProcessAdapter,
  repo: string,
  branch: string,
  base: string,
): Promise<boolean> {
  const cherry = await run(process, "git", ["-C", repo, "cherry", base, branch]);
  if (cherry.kind === "ok" && cherry.value.stdout.split("\n").every((line) => !line.startsWith("+"))) return true;

  const trees = await run(process, "git", ["-C", repo, "rev-parse", `${base}^{tree}`, `${branch}^{tree}`]);
  if (trees.kind === "ok") {
    const [baseTree, branchTree] = trees.value.stdout.trim().split(/\s+/);
    if (baseTree !== undefined && baseTree === branchTree) return true;
  }

  const tip = await run(process, "git", ["-C", repo, "rev-parse", branch]);
  if (tip.kind !== "ok") return false;
  const pull = await process.run("gh", ["pr", "list", "--state", "merged", "--head", branch, "--base", base, "--json", "headRefOid,state"], { cwd: repo, timeoutMs: 5_000 });
  if (pull.kind !== "ok") return false;
  try {
    const entries: unknown = JSON.parse(pull.value.stdout);
    return Array.isArray(entries) && entries.some((entry) =>
      typeof entry === "object" && entry !== null && "state" in entry && entry.state === "MERGED" &&
      "headRefOid" in entry && entry.headRefOid === tip.value.stdout.trim(),
    );
  } catch {
    return false;
  }
}

export async function resolveFinishBase(
  process: ProcessAdapter,
  repo: string,
  path: string,
  branch: string,
  value: FinishOptions,
): Promise<Result<FinishBase>> {
  if (value.base !== undefined)
    return ok({ ref: value.base, source: "explicit" });
  if (!value.deleteBranch || branch.length === 0)
    return ok({ ref: "", source: "" });
  const parent = await parentBranch(process, path, branch);
  const fallback = await defaultBase(process, repo);
  if (parent !== undefined) {
    const exists = await localBranchExists(process, repo, parent);
    if (exists.kind === "ok" && exists.value)
      return ok({ ref: parent, source: "recorded-parent" });
    return ok({
      ref: fallback,
      source: "repository-default",
      warning:
        "recorded parent branch no longer exists: " +
        parent +
        "; judging against repository default base " +
        fallback,
    });
  }
  return ok({ ref: fallback, source: "repository-default" });
}
export function finishRefusal(
  json: boolean,
  message: string,
  code: string,
  exitCode = 1,
): Result<string> {
  if (!json) return failed(message, exitCode);
  return {
    kind: "ok",
    value: finishJson({
      deleted: false,
      refusal: { code, message },
    }),
    exitCode,
    stderr: "megabrain: " + message + "\n",
  };
}
const pause = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
const pathExists = (path: string) => lstat(path).then(() => true, () => false);

// WHY: the host remover (Orca's cascade) deletes the folder on its own schedule and can answer
// with a failure after it already did, so the folder, not the exit code, says whether the
// removal happened. Returns whether the folder is gone within the settle window.
export async function folderGone(path: string, environment: Environment): Promise<boolean> {
  const configured = Number(environment.MEGABRAIN_FINISH_SETTLE_MS);
  const deadline = Date.now() + (Number.isFinite(configured) && configured >= 0 ? configured : 10_000);
  while (await pathExists(path)) {
    if (Date.now() >= deadline) return false;
    await pause(100);
  }
  return true;
}

export async function removeFinishWorktree(
  process: ProcessAdapter,
  repo: string,
  path: string,
  force: boolean,
  workspace: Workspace | undefined,
): Promise<Result<null>> {
  if (workspace?.id !== undefined) {
    const removed = await run(process, "superset", [
      "workspaces",
      "delete",
      workspace.id,
      "--local",
      "--json",
    ]);
    return removed.kind === "ok"
      ? ok(null)
      : failed(removalReason(removed.error), removed.exitCode);
  }
  if (await hasCommand(process, "orca")) {
    const args = ["worktree", "rm", "--worktree", "path:" + path];
    if (force) args.push("--force");
    args.push("--json");
    const removed = await run(process, "orca", args);
    return removed.kind === "ok"
      ? ok(null)
      : failed(removalReason(removed.error), removed.exitCode);
  }
  const removed = await run(process, "git", [
    "-C",
    repo,
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    path,
  ]);
  return removed.kind === "ok"
    ? ok(null)
    : failed(removalReason(removed.error), removed.exitCode);
}
export async function resolveParent(
  process: ProcessAdapter,
  repo: string,
  selector: string,
): Promise<Result<{ branch: string; tag: string }>> {
  const match = /^(branch|path):(.*)$/.exec(selector);
  if (!match || !match[2])
    return failed(
      `parent worktree could not be resolved: ${selector} (use branch:<branch> or path:<path>)`,
    );
  let path = match[1] === "path" ? match[2] : "";
  if (match[1] === "branch") {
    const listed = await run(process, "git", [
      "-C",
      repo,
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (listed.kind !== "ok")
      return failed(`parent worktree could not be resolved: ${selector}`);
    let current = "";
    for (const line of listed.value.stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      if (line === `branch refs/heads/${match[2]}`) {
        path = current;
        break;
      }
    }
    // WHY: git treats `-C ""` as no -C at all, so an unmatched branch selector must refuse here
    // rather than let the calls below silently run against the caller's own cwd instead of the
    // (nonexistent) parent worktree.
    if (path === "") return failed(`parent worktree could not be resolved: ${selector}`);
  }
  const top = await run(process, "git", [
    "-C",
    path,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (top.kind !== "ok")
    return failed(`parent worktree could not be resolved: ${selector}`);
  const branch = await run(process, "git", [
    "-C",
    path,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch.kind !== "ok" || !branch.value.stdout.trim())
    return failed(`parent worktree is detached: ${selector}`);
  const name = branch.value.stdout.trim();
  return ok({ branch: name, tag: name.replaceAll("/", "-") });
}
export function output(value: unknown, json: boolean): string {
  return json
    ? `${JSON.stringify(value, null, 2)}\n`
    : `worktree: ${(value as { worktree: string }).worktree}\nbranch: ${(value as { branch: string }).branch}\nbase: ${(value as { base: string }).base}\nbase commit: ${(value as { baseCommit: string }).baseCommit}\n`;
}
function isEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}
export async function copyEnvFiles(
  sourceRoot: string,
  destinationRoot: string,
): Promise<Result<null>> {
  async function walk(relativeDirectory: string): Promise<Result<null>> {
    const sourceDirectory = join(sourceRoot, relativeDirectory);
    let entries;
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch {
      return failed(`could not read directory for ${relativeDirectory || "."}`);
    }
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativeDirectory === "" && entry.name === ".git") continue;
      if (entry.isDirectory()) {
        const nested = await walk(relativePath);
        if (nested.kind !== "ok") return nested;
        continue;
      }
      if (!isEnvFile(entry.name) || (!entry.isFile() && !entry.isSymbolicLink()))
        continue;
      const sourceFile = join(sourceRoot, relativePath);
      const destinationFile = join(destinationRoot, relativePath);
      try {
        await mkdir(dirname(destinationFile), { recursive: true });
        const metadata = await lstat(sourceFile);
        if (metadata.isSymbolicLink()) {
          await symlink(await readlink(sourceFile), destinationFile);
        } else {
          await copyFile(sourceFile, destinationFile);
          await chmod(destinationFile, metadata.mode);
          await utimes(destinationFile, metadata.atime, metadata.mtime);
        }
      } catch {
        return failed(`could not copy ${relativePath}`);
      }
    }
    return ok(null);
  }
  return walk("");
}
