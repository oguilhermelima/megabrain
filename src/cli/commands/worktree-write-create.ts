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

import { defaultBase, localBranchExists, pathFor, readWorktreeLocation, root, run, createBase, stateDirectory, excludeWorktreesFolder, removeCreatedBranch, type Environment } from "./worktree-write-base.js";
import { ensureSupersetProject, registerSupersetWorkspace, type Workspace, workspaceForTarget } from "./worktree-write-workspace.js";
import { copyEnvFiles, output, resolveParent } from "./worktree-write-support.js";
export async function executeWorktreeCreate(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help"))
    return ok(usageText("worktree-create"));
  const options = parseCreateOptions(args);
  if (options.kind !== "ok") return options;
  const value: CreateOptions = options.value;
  const repo = await repoFromOrca(process, value.repo as string, environment);
  if (repo.kind !== "ok") return repo;
  const placement = placementFor(await readWorktreeLocation(environment), repo.value);
  // Only the default placement needs the shared root file; the other modes must work without it.
  const shared = await root(environment, placement.mode !== "custom" || placement.customRoot !== null);
  if (shared.kind !== "ok") return shared;
  const branch = value.branch as string;
  // Validated before anything is created: an unresolvable --parent must refuse with nothing left
  // behind, not fail after `git worktree add` has already created the branch and worktree.
  let resolvedParent: { branch: string; tag: string } | undefined;
  if (value.parent !== undefined) {
    const resolved = await resolveParent(process, repo.value, value.parent);
    if (resolved.kind !== "ok") return resolved;
    resolvedParent = resolved.value;
  }
  const resolvedBase = await createBase(process, repo.value, value.from ?? value.base);
  if (resolvedBase.kind !== "ok") return resolvedBase;
  const base = resolvedBase.value.ref;
  const name = value.name ?? createName(branch);
  if (!name) return failed("branch cannot produce a safe slug");
  const folder = worktreeParent(placement, {
    repoPath: repo.value,
    repoName: basename(repo.value),
    stateDir: stateDirectory(environment),
    sharedRoot: shared.value,
  });
  const path = join(folder, name);
  // WHY: only a branch absent before this invocation may be removed on add failure.
  const branchBefore = await localBranchExists(process, repo.value, branch);
  if (branchBefore.kind !== "ok")
    return failed(`could not check whether branch exists: ${branch}`);
  if (placement.mode === "repo") {
    const excluded = await excludeWorktreesFolder(process, repo.value);
    if (excluded.kind !== "ok") return excluded;
  }
  await mkdir(folder, { recursive: true });
  const added = await run(process, "git", [
    "-C",
    repo.value,
    "worktree",
    "add",
    path,
    "-b",
    branch,
    // WHY: the sha resolved above, never the ref name, so the worktree starts exactly where
    // baseCommit says and a ref that moves meanwhile cannot change the base.
    resolvedBase.value.commit,
  ]);
  if (added.kind !== "ok") {
    const removed = await removeCreatedBranch(
      process,
      repo.value,
      branch,
      branchBefore.value,
    );
    return removed.kind === "ok"
      ? failed("could not create git worktree")
      : failed(`could not create git worktree; ${removed.error}`);
  }
  const copied = await copyEnvFiles(repo.value, path);
  if (copied.kind !== "ok") return copied;
  // A caller running inside a Superset terminal registers the new worktree as a Superset
  // workspace, the way the retired shell's megabrain_worktree_create did for both plain
  // `worktree create` and `orchestrate spawn`'s own worktree-creation path. A requested parent
  // tags the new workspace into the same Superset grouping as its parent worktree.
  const caller = await resolveCaller(environment, process);
  let workspaceId: string | null = null;
  let grouping: { set: boolean; error: string | null } = { set: false, error: null };
  if (caller.host === "superset") {
    const project = await ensureSupersetProject(process, repo.value);
    if (project.kind !== "ok") return project;
    const registered = await registerSupersetWorkspace(process, project.value, branch, name, {
      tag: resolvedParent?.tag,
      pr: value.pr,
    });
    if (registered.kind !== "ok") return registered;
    workspaceId = registered.value.id;
    if (resolvedParent !== undefined)
      grouping = { set: registered.value.tagSet, error: registered.value.tagError };
  }
  let parent: {
    requested: boolean;
    selector?: string;
    branch?: string;
    tag?: string;
    metadata?: { set: boolean; error: string | null };
    lineage?: { set: boolean; error: string | null };
    grouping?: { set: boolean; error: string | null };
  } = { requested: false };
  let links: {
    issue: string | null;
    linearIssue: string | null;
    set: boolean;
    error: string | null;
  } = {
    issue: value.issue ?? null,
    linearIssue: value.linearIssue ?? null,
    set: false,
    error: null,
  };
  if (resolvedParent !== undefined) {
    const metadata = await run(process, "git", [
      "-C",
      path,
      "config",
      `branch.${branch}.megabrain-parent`,
      resolvedParent.branch,
    ]);
    parent = {
      requested: true,
      selector: value.parent,
      branch: resolvedParent.branch,
      tag: resolvedParent.tag,
      metadata: {
        set: metadata.kind === "ok",
        error:
          metadata.kind === "ok"
            ? null
            : `Git stack parent metadata was not recorded for ${branch}`,
      },
      lineage: { set: false, error: null },
      grouping,
    };
  }
  if (
    value.parent !== undefined ||
    value.issue !== undefined ||
    value.linearIssue !== undefined
  ) {
    const setArgs = ["worktree", "set", "--worktree", `path:${path}`];
    if (value.parent !== undefined)
      setArgs.push("--parent-worktree", value.parent);
    if (value.issue !== undefined) setArgs.push("--issue", value.issue);
    if (value.linearIssue !== undefined)
      setArgs.push("--linear-issue", value.linearIssue);
    setArgs.push("--json");
    const configured = await run(process, "orca", setArgs);
    if (value.parent !== undefined)
      parent = {
        ...parent,
        lineage: {
          set: configured.kind === "ok",
          error:
            configured.kind === "ok"
              ? null
              : `Orca parent lineage was not set for ${value.parent}`,
        },
      };
    if (value.issue !== undefined || value.linearIssue !== undefined)
      links = {
        ...links,
        set: configured.kind === "ok",
        error:
          configured.kind === "ok" ? null : "Orca issue links were not set",
      };
  }
  const result = {
    path,
    worktree: path,
    branch,
    workspace: workspaceId,
    reused: false,
    base,
    baseCommit: resolvedBase.value.commit,
    resolvedSha: resolvedBase.value.commit,
    baseSource: resolvedBase.value.source,
    parent,
    links,
  };
  try {
    await callStateOwner(resolveStateDirectory(environment), { operation: "worktree-write", action: "insert", worktree: {
      path, repo: repo.value, repoName: value.repo as string, branch, createdAt: new Date().toISOString(),
      createdBy: caller.id || null,
      purpose: value.label?.trim() || value.prompt?.split(/\r?\n/, 1)[0]?.trim() || null,
      origin: "created", finishedAt: null, parentBranch: resolvedParent?.branch ?? null,
    } });
  } catch (cause: unknown) { return failed(`worktree created at ${path}, but registry write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const registeredRepository = await registerMegabrainRepository(repo.value, environment, process);
  if (registeredRepository.kind !== "ok" && !registeredRepository.error.startsWith("not a git repository:")) {
    return failed(`worktree created at ${path}, but project registry write failed: ${registeredRepository.error}`);
  }
  return ok(output(result, value.json));
}
