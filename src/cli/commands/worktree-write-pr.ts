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

import { defaultBase, parentBranch, pathFor, root, run, type Environment } from "./worktree-write-base.js";
export async function executeWorktreePr(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  const parsed = parsePullRequestOptions(args);
  if (parsed.kind !== "ok") return parsed;
  const value: PullRequestOptions = parsed.value;
  if (!value.target)
    return failed(
      usageMessage("worktree-pr"),
      2,
    );
  const shared = await root(environment, true);
  if (shared.kind !== "ok") return shared;
  const path = await pathFor(process, value.target, shared.value, environment);
  if (path.kind !== "ok") return path;
  const branch = await run(process, "git", [
    "-C",
    path.value,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch.kind !== "ok" || !branch.value.stdout.trim())
    return failed(
      `cannot open a pull request from detached worktree: ${path.value}`,
    );
  const name = branch.value.stdout.trim();
  const repo = path.value;
  let base = value.base;
  if (!base)
    base =
      (await parentBranch(process, repo, name)) ??
      (await defaultBase(process, repo));
  const title = value.title ?? name;
  const gh = await run(process, "gh", ["auth", "status"]);
  if (gh.kind !== "ok") {
    return failed(
      gh.error.includes("not found") ||
        gh.error.includes("No such file") ||
        gh.error.includes("Executable")
        ? "gh CLI is not installed"
        : "gh CLI is not authenticated",
    );
  }
  const verified = await run(process, "git", [
    "-C",
    repo,
    "rev-parse",
    "--verify",
    `${base}^{commit}`,
  ]);
  if (verified.kind !== "ok")
    return failed(`pull request base does not exist: ${base}`);
  const ahead = await run(process, "git", [
    "-C",
    repo,
    "rev-list",
    "--count",
    `${base}..${name}`,
  ]);
  if (ahead.kind !== "ok" || Number(ahead.value.stdout.trim()) === 0)
    return failed(
      `refusing to open a pull request: no commits ahead of base ${base}`,
    );
  const created = await run(process, "gh", [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    name,
    "--title",
    title,
    "--body",
    value.body ?? "",
  ]);
  if (created.kind !== "ok")
    return failed(`could not open a pull request: ${created.error}`);
  return ok(
    value.json
      ? `${JSON.stringify({ worktree: path.value, branch: name, base, title, body: value.body ?? "", url: created.value.stdout.trim() })}\n`
      : created.value.stdout,
  );
}
