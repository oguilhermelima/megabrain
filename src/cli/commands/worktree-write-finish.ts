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
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";
import { listRepositories } from "../../db/queries/repositories.js";
import {
  defaultWorktreeLocation,
  parseWorktreeLocation,
  placementFor,
  worktreeParent,
  type WorktreeLocation,
} from "../../core/worktree-location.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";

import { defaultBase, localBranchExists, parentBranch, pathFor, repositoryRoot, root, run, type Environment } from "./worktree-write-base.js";
import { type Workspace, workspaceForTarget } from "./worktree-write-workspace.js";
import { changesAlreadyMerged, finishRefusal, folderGone, removalReason, removeFinishWorktree, resolveFinishBase } from "./worktree-write-support.js";
export async function executeWorktreeFinish(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  const parsed = parseFinishOptions(args);
  if (parsed.kind !== "ok")
    return args.includes("--json")
      ? finishRefusal(true, parsed.error, "invalid-arguments", parsed.exitCode)
      : parsed;
  const value: FinishOptions = parsed.value;
  if (!value.target)
    return finishRefusal(
      value.json,
      usageMessage("worktree-finish"),
      "invalid-arguments",
      2,
    );
  const shared = await root(environment, true);
  if (shared.kind !== "ok") return shared;
  const workspace = await workspaceForTarget(process, value.target);
  if (workspace.kind !== "ok") return workspace;
  const found =
    workspace.value?.path !== undefined
      ? ok(workspace.value.path)
      : await pathFor(process, value.target, shared.value, environment);
  if (found.kind !== "ok")
    return finishRefusal(value.json, found.error, "worktree-not-found");
  const path = found.value;
  const repo = await repositoryRoot(process, path);
  if (repo.kind !== "ok") return repo;
  const branchResult = await run(process, "git", [
    "-C",
    path,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const branch =
    branchResult.kind === "ok" ? branchResult.value.stdout.trim() : "";
  const base = await resolveFinishBase(
    process,
    repo.value,
    path,
    branch,
    value,
  );
  if (base.kind !== "ok") return base;
  const baseRef = base.value.ref;
  const baseSource = base.value.source;
  const baseWarning = base.value.warning;
  const warning = baseWarning === undefined ? "" : baseWarning + "\n";
  if (value.deleteBranch && branch && !value.force) {
    const merged = await run(process, "git", [
      "-C",
      repo.value,
      "branch",
      "--merged",
      baseRef,
    ]);
    const notAncestor =
      merged.kind !== "ok" ||
      !merged.value.stdout.split("\n").some(
        (line) =>
          line
            .trim()
            .replace(/^[*+]\s*/, "")
            .trim() === branch,
      );
    if (notAncestor && !(await changesAlreadyMerged(process, repo.value, branch, baseRef))) {
      const message =
        "refusing to delete unmerged branch: " +
        branch +
        " against base " +
        baseRef +
        " (use --force to override)";
      if (value.json) {
        return {
          kind: "ok",
          value: finishJson({
            deleted: false,
            branch,
            path,
            base: baseRef,
            baseSource,
            baseWarning,
            refusal: { code: "unmerged-branch", message },
          }),
          exitCode: 1,
          stderr: warning + "megabrain: " + message + "\n",
        };
      }
      if (warning.length > 0)
        return {
          kind: "ok",
          value: "",
          exitCode: 1,
          stderr: warning + "megabrain: " + message + "\n",
        };
      return failed(message);
    }
  }
  const removed = await removeFinishWorktree(
    process,
    repo.value,
    path,
    value.force,
    workspace.value,
  );
  const gone = await folderGone(path, environment);
  if (gone) await run(process, "git", ["-C", repo.value, "worktree", "prune"]);
  if (!gone) {
    const reason = removed.kind === "ok"
      ? "the folder is still present after the host reported success"
      : "the folder is still present after the host failed: " + removalReason(removed.error);
    const message = "could not remove worktree " + path + ": " + reason;
    return value.json
      ? {
          kind: "ok",
          value: finishJson({
            deleted: false,
            branch,
            path,
            base: baseRef || undefined,
            baseSource: baseSource || undefined,
            baseWarning,
            error: reason,
          }),
          exitCode: removed.kind === "ok" ? 1 : removed.exitCode,
          stderr: warning + "megabrain: " + message + "\n",
        }
      : failed(message, removed.kind === "ok" ? 1 : removed.exitCode);
  }
  let branchDeleted: boolean | undefined;
  let branchOutput = "";
  if (value.deleteBranch && branch) {
    const exists = await localBranchExists(process, repo.value, branch);
    if (exists.kind === "ok" && exists.value) {
      const deleteBranch = () => run(process, "git", ["-C", repo.value, "branch", "-D", branch]);
      let deleted = await deleteBranch();
      if (deleted.kind !== "ok" && /used by worktree|checked out/.test(deleted.error)) {
        // git still lists the removed folder until it is pruned.
        await run(process, "git", ["-C", repo.value, "worktree", "prune"]);
        deleted = await deleteBranch();
      }
      if (deleted.kind === "ok") {
        branchDeleted = true;
        branchOutput = deleted.value.stdout.trim();
      } else {
        const reason = removalReason(deleted.error);
        const message =
          "could not delete branch: " + branch + ": " + reason;
        return value.json
          ? {
              kind: "ok",
              value: finishJson({
                deleted: true,
                branch,
                path,
                base: baseRef || undefined,
                baseSource: baseSource || undefined,
                baseWarning,
                branchDeleted: false,
                error: reason,
              }),
              exitCode: deleted.exitCode,
              stderr: warning + "megabrain: " + message + "\n",
            }
          : failed(message, deleted.exitCode);
      }
    } else {
      branchDeleted = false;
    }
  }
  try { await callStateOwner(resolveStateDirectory(environment), { operation: "worktree-write", action: "finish", path, finishedAt: new Date().toISOString() }); }
  catch (cause: unknown) { return failed(`worktree was removed, but registry update failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (value.json)
    return {
      kind: "ok",
      value: finishJson({
        deleted: true,
        branch,
        path,
        base: baseRef || undefined,
        baseSource: baseSource || undefined,
        baseWarning,
        branchDeleted,
      }),
      stderr: warning.length > 0 ? warning : undefined,
    };
  let human = "removed: " + path + "\n";
  if (value.deleteBranch && branch) {
    human +=
      "judged branch " +
      branch +
      " against base " +
      baseRef +
      " (" +
      baseSource +
      ")\n";
    if (branchDeleted === false)
      human += "branch already absent: " + branch + "\n";
    else if (branchOutput.length > 0) human += branchOutput + "\n";
  }
  return ok(human);
}
